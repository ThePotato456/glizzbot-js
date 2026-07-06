import { spawn } from "node:child_process";
import type { QueueSourceType, RuntimePaths } from "../types.js";

interface YtDlpMetadata {
  id?: string;
  title?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  extractor?: string;
  extractor_key?: string;
  ie_key?: string;
  http_headers?: Record<string, string>;
  entries?: Array<YtDlpMetadata | null>;
}

export interface ResolvedMediaResult {
  title: string;
  input: string;
  sourceType: QueueSourceType;
  durationSeconds?: number;
  streamUrl: string;
  streamHeaders?: Record<string, string>;
  webpageUrl?: string;
  extractor?: string;
  requestedQuery?: string;
}

export interface ResolvedPlaylistEntry {
  title: string;
  url: string;
  durationSeconds?: number;
}

export interface ResolvedPlaylistResult {
  title: string;
  entries: ResolvedPlaylistEntry[];
  extractor?: string;
}

export type YtDlpRunner = (args: string[]) => Promise<string>;
export type YtDlpDiagnosticLogger = (message: string) => void;

const MEDIA_CACHE_TTL_MS = 2 * 60 * 1000;
const PLAYLIST_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class YtDlpService {
  private readonly mediaCache = new Map<string, CacheEntry<ResolvedMediaResult>>();
  private readonly playlistCache = new Map<string, CacheEntry<ResolvedPlaylistResult>>();
  private readonly inFlightMedia = new Map<string, Promise<ResolvedMediaResult>>();
  private readonly inFlightPlaylists = new Map<string, Promise<ResolvedPlaylistResult>>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly runner: YtDlpRunner | null = null,
    private readonly executablePath = "yt-dlp",
    private readonly onDiagnostic: YtDlpDiagnosticLogger | null = null,
  ) {}

  async resolve(input: string, sourceType: QueueSourceType): Promise<ResolvedMediaResult> {
    const cacheKey = `${sourceType}:${input}`;
    const cached = this.getCached(this.mediaCache, cacheKey);
    if (cached) {
      this.logDiagnostic(`media cache hit source=${sourceType} input=${JSON.stringify(input)}`);
      return cached;
    }

    const inFlight = this.inFlightMedia.get(cacheKey);
    if (inFlight) {
      this.logDiagnostic(`media in-flight reuse source=${sourceType} input=${JSON.stringify(input)}`);
      return inFlight;
    }

    const resolution = this.resolveFresh(input, sourceType);
    this.inFlightMedia.set(cacheKey, resolution);
    try {
      const result = await resolution;
      this.setCached(this.mediaCache, cacheKey, result, MEDIA_CACHE_TTL_MS);
      return result;
    } finally {
      this.inFlightMedia.delete(cacheKey);
    }
  }

  async resolvePlaylist(input: string): Promise<ResolvedPlaylistResult> {
    const cached = this.getCached(this.playlistCache, input);
    if (cached) {
      this.logDiagnostic(`playlist cache hit input=${JSON.stringify(input)}`);
      return cached;
    }

    const inFlight = this.inFlightPlaylists.get(input);
    if (inFlight) {
      this.logDiagnostic(`playlist in-flight reuse input=${JSON.stringify(input)}`);
      return inFlight;
    }

    const resolution = this.resolvePlaylistFresh(input);
    this.inFlightPlaylists.set(input, resolution);
    try {
      const result = await resolution;
      this.setCached(this.playlistCache, input, result, PLAYLIST_CACHE_TTL_MS);
      return result;
    } finally {
      this.inFlightPlaylists.delete(input);
    }
  }

  private async resolveFresh(input: string, sourceType: QueueSourceType): Promise<ResolvedMediaResult> {
    const query = sourceType === "search" ? `ytsearch1:${input}` : input;
    const startedAt = performance.now();
    const metadata = await this.fetchMetadata(query);
    const entry = metadata.entries?.find((candidate) => Boolean(candidate)) ?? metadata;
    if (!entry.url) {
      throw new Error("yt-dlp did not return a playable stream URL.");
    }
    this.logDiagnostic(
      `media resolved source=${sourceType} input=${JSON.stringify(input)} elapsed_ms=${(performance.now() - startedAt).toFixed(1)} extractor=${entry.extractor ?? "unknown"}`,
    );

    return {
      title: entry.title ?? input,
      input,
      sourceType,
      durationSeconds: entry.duration,
      streamUrl: entry.url,
      streamHeaders: entry.http_headers,
      webpageUrl: entry.webpage_url ?? entry.original_url ?? input,
      extractor: entry.extractor,
      requestedQuery: sourceType === "search" ? input : undefined,
    };
  }

  private async resolvePlaylistFresh(input: string): Promise<ResolvedPlaylistResult> {
    const startedAt = performance.now();
    const metadata = await this.fetchPlaylistMetadata(input);
    const entries = (metadata.entries ?? [])
      .filter((entry): entry is YtDlpMetadata => Boolean(entry))
      .map((entry) => this.toPlaylistEntry(entry, input))
      .filter((entry): entry is ResolvedPlaylistEntry => Boolean(entry));
    this.logDiagnostic(
      `playlist resolved input=${JSON.stringify(input)} elapsed_ms=${(performance.now() - startedAt).toFixed(1)} entries=${entries.length} extractor=${metadata.extractor ?? "unknown"}`,
    );

    return {
      title: metadata.title ?? "Playlist",
      entries,
      extractor: metadata.extractor,
    };
  }

  private async fetchMetadata(input: string): Promise<YtDlpMetadata> {
    const stdout = await this.runYtDlp([
      "--dump-single-json",
      "--quiet",
      "--no-playlist",
      "--no-call-home",
      "--no-cache-dir",
      "--ignore-no-formats-error",
      "--no-warnings",
      "--skip-download",
      "-f", "bestaudio/best",
      input,
    ]);
    return JSON.parse(stdout) as YtDlpMetadata;
  }

  private async fetchPlaylistMetadata(input: string): Promise<YtDlpMetadata> {
    const stdout = await this.runYtDlp([
      "--dump-single-json",
      "--quiet",
      "--flat-playlist",
      "--no-call-home",
      "--no-cache-dir",
      "--no-warnings",
      "--skip-download",
      input,
    ]);
    return JSON.parse(stdout) as YtDlpMetadata;
  }

  private toPlaylistEntry(entry: YtDlpMetadata, fallbackInput: string): ResolvedPlaylistEntry | null {
    const url = this.getPlaylistEntryUrl(entry, fallbackInput);
    if (!url) {
      return null;
    }

    return {
      title: entry.title ?? url,
      url,
      durationSeconds: entry.duration,
    };
  }

  private getPlaylistEntryUrl(entry: YtDlpMetadata, fallbackInput: string): string | null {
    if (entry.webpage_url) {
      return entry.webpage_url;
    }

    if (entry.original_url) {
      return entry.original_url;
    }

    if (entry.url?.startsWith("http://") || entry.url?.startsWith("https://")) {
      return entry.url;
    }

    const extractorKey = (entry.extractor_key ?? entry.ie_key ?? entry.extractor ?? "").toLowerCase();
    if (entry.id && (extractorKey.includes("youtube") || extractorKey === "youtube")) {
      return `https://www.youtube.com/watch?v=${entry.id}`;
    }

    if (entry.id && (extractorKey.includes("soundcloud") || fallbackInput.includes("soundcloud.com"))) {
      return `https://soundcloud.com/${entry.id}`;
    }

    return null;
  }

  private runYtDlp(args: string[]): Promise<string> {
    if (this.runner) {
      return this.runner(args);
    }
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      this.logDiagnostic(`spawn executable=${this.executablePath} args=${JSON.stringify(args)}`);
      const child = spawn(this.executablePath, args, {
        cwd: this.paths.root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          this.logDiagnostic(`spawn complete executable=${this.executablePath} elapsed_ms=${(performance.now() - startedAt).toFixed(1)}`);
          resolve(stdout);
          return;
        }
        this.logDiagnostic(`spawn failed executable=${this.executablePath} elapsed_ms=${(performance.now() - startedAt).toFixed(1)} code=${code}`);
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      });
    });
  }

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const cached = cache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return cached.value;
  }

  private setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
    cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  private logDiagnostic(message: string): void {
    this.onDiagnostic?.(`[yt-dlp] ${message}`);
  }
}
