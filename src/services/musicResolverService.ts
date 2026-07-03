import type { QueueItem, QueueSourceType } from "../types.js";
import type { RuntimePaths } from "../types.js";
import { YtDlpService, type YtDlpRunner } from "./ytdlpService.js";

export interface ResolvedQueueRequest {
  items: Array<Omit<QueueItem, "id" | "addedAt">>;
  summary: string;
}

type DetectedSourceType = QueueSourceType | "spotifyPlaylist" | "spotifyAlbum" | "youtubePlaylist";

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
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

  constructor(private readonly paths: RuntimePaths, runner: YtDlpRunner | null = null) {
    this.ytdlp = new YtDlpService(paths, runner);
  }

  async resolveInput(query: string, requestedBy: string): Promise<ResolvedQueueRequest> {
    const normalized = query.trim();
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
        return {
          items: [],
          summary: "YouTube playlist URLs are not supported yet. Use a single video URL or a search query.",
        };
      case "url":
      default:
        return this.resolveViaYtDlp(normalized, requestedBy, "url");
    }
  }

  async resolveQueueItem(item: QueueItem): Promise<QueueItem> {
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

  private async prepareResolvedItem(item: QueueItem): Promise<QueueItem> {
    try {
      const prepared = await this.ytdlp.resolve(item.url, item.sourceType);
      return {
        ...item,
        title: prepared.title,
        durationSeconds: prepared.durationSeconds ?? item.durationSeconds,
        streamUrl: prepared.streamUrl,
        isResolved: true,
        resolverNote: `Resolved stream with yt-dlp${prepared.extractor ? ` (${prepared.extractor})` : ""}.`,
      };
    } catch (error) {
      return {
        ...item,
        isResolved: true,
        resolverNote: item.resolverNote
          ? `${item.resolverNote} yt-dlp failed: ${error instanceof Error ? error.message : String(error)}`
          : `yt-dlp failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
