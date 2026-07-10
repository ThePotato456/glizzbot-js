import type { QueueItem, QueueSourceType } from "../types.js";
import type { RuntimePaths } from "../types.js";
import { YtDlpService, type YtDlpDiagnosticLogger, type YtDlpRunner } from "./ytdlpService.js";

export interface ResolvedQueueRequest {
  items: Array<Omit<QueueItem, "id" | "addedAt">>;
  summary: string;
}

type DetectedSourceType = QueueSourceType | "spotifyPlaylist" | "spotifyAlbum" | "youtubePlaylist";

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function extractFirstPathSegment(pathname: string): string | null {
  return pathname.split("/").filter(Boolean)[0] ?? null;
}

function extractVideoIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  if (segments[0] === "shorts" || segments[0] === "live" || segments[0] === "embed" || segments[0] === "v") {
    return segments[1] ?? null;
  }

  return null;
}

function buildCanonicalYouTubeWatchUrl(videoId: string, listId?: string | null): string {
  const normalized = new URL("https://www.youtube.com/watch");
  normalized.searchParams.set("v", videoId);
  if (listId) {
    normalized.searchParams.set("list", listId);
  }
  return normalized.toString();
}

function buildCanonicalYouTubePlaylistUrl(listId: string): string {
  const normalized = new URL("https://www.youtube.com/playlist");
  normalized.searchParams.set("list", listId);
  return normalized.toString();
}

function normalizeMediaUrl(value: string): string {
  if (!isHttpUrl(value)) {
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  const host = url.hostname.toLowerCase();
  if (host === "music.youtube.com" || host === "m.youtube.com") {
    url.hostname = "www.youtube.com";
  }
  if (url.hostname.toLowerCase() === "youtube-nocookie.com" || url.hostname.toLowerCase() === "www.youtube-nocookie.com") {
    url.hostname = "www.youtube.com";
  }

  if (host === "youtu.be") {
    const videoId = extractFirstPathSegment(url.pathname);
    if (videoId) {
      return buildCanonicalYouTubeWatchUrl(videoId, url.searchParams.get("list"));
    }
  }

  const normalizedHost = url.hostname.toLowerCase();
  if (!normalizedHost.includes("youtube.com")) {
    return url.toString();
  }

  const pathVideoId = extractVideoIdFromPath(url.pathname);
  if (pathVideoId) {
    return buildCanonicalYouTubeWatchUrl(pathVideoId, url.searchParams.get("list"));
  }

  if (url.pathname === "/watch") {
    const videoId = url.searchParams.get("v");
    if (videoId) {
      return buildCanonicalYouTubeWatchUrl(videoId, url.searchParams.get("list"));
    }
  }

  if (url.pathname === "/playlist") {
    const list = url.searchParams.get("list");
    if (list) {
      return buildCanonicalYouTubePlaylistUrl(list);
    }
  }

  const listId = url.searchParams.get("list");
  if (listId) {
    const videoId = url.searchParams.get("v");
    if (videoId) {
      return buildCanonicalYouTubeWatchUrl(videoId, listId);
    }
    return buildCanonicalYouTubePlaylistUrl(listId);
  }

  return new URL(`https://www.youtube.com${url.pathname}`).toString();
}

function detectSourceType(query: string): DetectedSourceType {
  if (!isHttpUrl(query)) {
    return "search";
  }

  let url: URL;
  try {
    url = new URL(query);
  } catch {
    return "url";
  }

  const host = url.hostname.toLowerCase();
  if (host.includes("spotify.com")) {
    if (url.pathname.includes("/playlist/")) {
      return "spotifyPlaylist";
    }
    if (url.pathname.includes("/album/")) {
      return "spotifyAlbum";
    }
    return "spotify";
  }

  if ((host.includes("youtube.com") || host.includes("youtu.be")) && url.searchParams.has("list")) {
    return "youtubePlaylist";
  }

  return "url";
}

function buildBaseItem(
  title: string,
  query: string,
  requestedBy: string,
  sourceType: QueueSourceType,
  isResolved: boolean,
  resolverNote?: string,
): Omit<QueueItem, "id" | "addedAt"> {
  return {
    title,
    url: query,
    requestedBy,
    isResolved,
    sourceType,
    resolverNote,
    streamUrl: isResolved ? query : undefined,
  };
}

export class MusicResolverService {
  private readonly ytdlp: YtDlpService;

  constructor(
    private readonly paths: RuntimePaths,
    runner: YtDlpRunner | null = null,
    executablePath = "yt-dlp",
    onDiagnostic: YtDlpDiagnosticLogger | null = null,
  ) {
    this.ytdlp = new YtDlpService(paths, runner, executablePath, onDiagnostic);
  }

  async resolveInput(query: string, requestedBy: string): Promise<ResolvedQueueRequest> {
    const normalized = normalizeMediaUrl(query.trim());
    const sourceType = detectSourceType(normalized);

    switch (sourceType) {
      case "search":
        return this.resolveViaYtDlp(normalized, requestedBy, "search");
      case "spotify":
        return this.resolveViaYtDlp(normalized, requestedBy, "spotify");
      case "spotifyPlaylist":
        return {
          items: [],
          summary: "Spotify playlist URLs are not supported yet. Use `play <query or url>` with a single track or search query.",
        };
      case "spotifyAlbum":
        return {
          items: [],
          summary: "Spotify album URLs are not supported yet. Use `play <query or url>` with a single track or search query.",
        };
      case "youtubePlaylist":
        return this.resolvePlaylist(normalized, requestedBy);
      case "url":
      default:
        return this.resolveViaYtDlp(normalized, requestedBy, "url");
    }
  }

  async resolveQueueItem(item: QueueItem): Promise<QueueItem> {
    if (item.isResolved && item.streamUrl) {
      return item;
    }

    if (item.isResolved) {
      return this.prepareResolvedItem(item);
    }

    switch (item.sourceType) {
      case "search":
        return this.prepareResolvedItem(item);
      case "spotify":
        return this.prepareResolvedItem(item);
      case "spotifyPlaylist":
      case "spotifyAlbum":
      case "youtubePlaylist":
        return {
          ...item,
          isResolved: true,
          resolverNote: "Playlist and collection expansion are not configured yet.",
        };
      default:
        return this.prepareResolvedItem(item);
    }
  }

  private async resolveViaYtDlp(
    input: string,
    requestedBy: string,
    sourceType: QueueSourceType,
  ): Promise<ResolvedQueueRequest> {
    try {
      const prepared = await this.ytdlp.resolve(input, sourceType);
      return {
        items: [
          {
            title: prepared.title,
            url: prepared.webpageUrl ?? prepared.input,
            requestedBy,
            durationSeconds: prepared.durationSeconds,
            isResolved: true,
            sourceType,
            streamUrl: prepared.streamUrl,
            streamHeaders: prepared.streamHeaders,
            resolverNote: `Resolved stream with yt-dlp${prepared.extractor ? ` (${prepared.extractor})` : ""}.`,
          },
        ],
        summary: `Resolved with yt-dlp: **${prepared.title}**`,
      };
    } catch (error) {
      return {
        items: [
          buildBaseItem(
            input,
            input,
            requestedBy,
            sourceType,
            false,
            `yt-dlp prepare failed and will be retried on playback: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ],
        summary: `Queued ${sourceType === "search" ? "query" : "URL"} for yt-dlp resolution on playback.`,
      };
    }
  }

  private async resolvePlaylist(input: string, requestedBy: string): Promise<ResolvedQueueRequest> {
    try {
      const prepared = await this.ytdlp.resolvePlaylist(input);
      const items = prepared.entries.map((entry) => ({
        title: entry.title,
        url: entry.url,
        requestedBy,
        durationSeconds: entry.durationSeconds,
        isResolved: false,
        sourceType: "url" as const,
        resolverNote: `Queued from playlist${prepared.title ? `: ${prepared.title}` : ""}. Stream will resolve before playback.`,
      }));

      if (items.length === 0) {
        return {
          items: [],
          summary: "No playable entries were found in that playlist.",
        };
      }

      return {
        items,
        summary: `Queued ${items.length} track(s) from playlist: **${prepared.title}**`,
      };
    } catch (error) {
      return {
        items: [],
        summary: `Failed to expand playlist with yt-dlp: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async prepareResolvedItem(item: QueueItem): Promise<QueueItem> {
    try {
      const prepared = await this.ytdlp.resolve(item.url, item.sourceType);
      return {
        ...item,
        title: prepared.title,
        durationSeconds: prepared.durationSeconds ?? item.durationSeconds,
        streamUrl: prepared.streamUrl,
        streamHeaders: prepared.streamHeaders,
        isResolved: true,
        resolverNote: `Resolved stream with yt-dlp${prepared.extractor ? ` (${prepared.extractor})` : ""}.`,
      };
    } catch (error) {
      return {
        ...item,
        isResolved: false,
        resolverNote: item.resolverNote
          ? `${item.resolverNote} yt-dlp failed: ${error instanceof Error ? error.message : String(error)}`
          : `yt-dlp failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
