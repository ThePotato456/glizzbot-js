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
  entries?: Array<YtDlpMetadata | null>;
}

export interface ResolvedMediaResult {
  title: string;
  input: string;
  sourceType: QueueSourceType;
  durationSeconds?: number;
  streamUrl: string;
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

export class YtDlpService {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly runner: YtDlpRunner | null = null,
  ) {}

  async resolve(input: string, sourceType: QueueSourceType): Promise<ResolvedMediaResult> {
    const query = sourceType === "search" ? `ytsearch1:${input}` : input;
    const metadata = await this.fetchMetadata(query);
    const entry = metadata.entries?.find((candidate) => Boolean(candidate)) ?? metadata;
    if (!entry.url) {
      throw new Error("yt-dlp did not return a playable stream URL.");
    }

    return {
      title: entry.title ?? input,
      input,
      sourceType,
      durationSeconds: entry.duration,
      streamUrl: entry.url,
      webpageUrl: entry.webpage_url ?? entry.original_url ?? input,
      extractor: entry.extractor,
      requestedQuery: sourceType === "search" ? input : undefined,
    };
  }

  async resolvePlaylist(input: string): Promise<ResolvedPlaylistResult> {
    const metadata = await this.fetchPlaylistMetadata(input);
    const entries = (metadata.entries ?? [])
      .filter((entry): entry is YtDlpMetadata => Boolean(entry))
      .map((entry) => this.toPlaylistEntry(entry, input))
      .filter((entry): entry is ResolvedPlaylistEntry => Boolean(entry));

    return {
      title: metadata.title ?? "Playlist",
      entries,
      extractor: metadata.extractor,
    };
  }

  private async fetchMetadata(input: string): Promise<YtDlpMetadata> {
    const stdout = await this.runYtDlp([
      "--dump-single-json",
      "--no-playlist",
      "-f", "bestaudio/best",
      input,
    ]);
    return JSON.parse(stdout) as YtDlpMetadata;
  }

  private async fetchPlaylistMetadata(input: string): Promise<YtDlpMetadata> {
    const stdout = await this.runYtDlp([
      "--dump-single-json",
      "--flat-playlist",
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
      const child = spawn("yt-dlp", args, {
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
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      });
    });
  }
}
