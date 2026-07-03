import { EmbedBuilder } from "discord.js";
import type { QueueItem } from "../types.js";
import { formatDuration, toCurveText } from "../utils/format.js";

const MUSIC_EMBED_TITLE = toCurveText("MusicBot");

export function createMusicEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(MUSIC_EMBED_TITLE)
    .setDescription(description);
}

export function buildTrackEmbed(
  title: string,
  track: Pick<QueueItem, "title" | "requestedBy" | "durationSeconds">,
): EmbedBuilder {
  return createMusicEmbed(`**__${title}:__**\n${title === "Now Playing" ? "\t\t" : ""}${track.title}`)
    .addFields(
      { name: toCurveText("Queued By"), value: track.requestedBy || "Unknown", inline: true },
      { name: toCurveText("Song Length"), value: formatDuration(track.durationSeconds), inline: true },
    );
}
