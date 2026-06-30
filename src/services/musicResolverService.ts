import type { QueueItem, QueueSourceType } from "../types.js";

export interface ResolvedQueueRequest {
  items: Array<Omit<QueueItem, "id" | "addedAt">>;
  summary: string;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function detectSourceType(query: string): QueueSourceType {
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
  async resolveInput(query: string, requestedBy: string): Promise<ResolvedQueueRequest> {
    const normalized = query.trim();
    const sourceType = detectSourceType(normalized);

    switch (sourceType) {
      case "search":
        return {
          items: [
            buildBaseItem(
              `Search: ${normalized}`,
              normalized,
              requestedBy,
              "search",
              false,
              "Plain text searches stay unresolved until playback so the queue stays responsive.",
            ),
          ],
          summary: `Queued search query: **${normalized}**`,
        };
      case "spotify":
        return {
          items: [
            buildBaseItem(
              `Spotify track: ${normalized}`,
              normalized,
              requestedBy,
              "spotify",
              false,
              "Spotify tracks need a YouTube match step before playback.",
            ),
          ],
          summary: "Queued 1 Spotify track for lazy resolution.",
        };
      case "spotifyPlaylist":
        return {
          items: [
            buildBaseItem(
              `Spotify playlist: ${normalized}`,
              normalized,
              requestedBy,
              "spotifyPlaylist",
              false,
              "Playlist expansion is deferred until a Spotify adapter is configured.",
            ),
          ],
          summary: "Queued a Spotify playlist placeholder.",
        };
      case "spotifyAlbum":
        return {
          items: [
            buildBaseItem(
              `Spotify album: ${normalized}`,
              normalized,
              requestedBy,
              "spotifyAlbum",
              false,
              "Album expansion is deferred until a Spotify adapter is configured.",
            ),
          ],
          summary: "Queued a Spotify album placeholder.",
        };
      case "youtubePlaylist":
        return {
          items: [
            buildBaseItem(
              `YouTube playlist: ${normalized}`,
              normalized,
              requestedBy,
              "youtubePlaylist",
              false,
              "Playlist items are kept lazy so large collections do not block command handling.",
            ),
          ],
          summary: "Queued a YouTube playlist placeholder.",
        };
      case "url":
      default:
        return {
          items: [
            buildBaseItem(normalized, normalized, requestedBy, "url", true),
          ],
          summary: `Queued direct URL: **${normalized}**`,
        };
    }
  }

  async resolveQueueItem(item: QueueItem): Promise<QueueItem> {
    if (item.isResolved) {
      return item;
    }

    switch (item.sourceType) {
      case "search":
        return {
          ...item,
          title: item.title.startsWith("Search: ") ? item.title.slice("Search: ".length) : item.title,
          streamUrl: `ytsearch:${item.url}`,
          isResolved: true,
          resolverNote: "Resolved as a deferred search placeholder.",
        };
      case "spotify":
        return {
          ...item,
          streamUrl: `spotify-match:${item.url}`,
          isResolved: true,
          resolverNote: "Resolved to a placeholder Spotify-to-YouTube match target.",
        };
      case "spotifyPlaylist":
      case "spotifyAlbum":
      case "youtubePlaylist":
        return {
          ...item,
          streamUrl: item.url,
          isResolved: true,
          resolverNote: "Resolved from a lazy collection placeholder.",
        };
      default:
        return {
          ...item,
          streamUrl: item.url,
          isResolved: true,
        };
    }
  }
}
