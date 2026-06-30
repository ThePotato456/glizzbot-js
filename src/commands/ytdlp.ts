import type { BotCommand } from "../types.js";

export function createYtdlpCommands(): BotCommand[] {
  return [
    {
      name: "download",
      aliases: ["dl", "ytdlp", "ytdl"],
      cog: "ytdlp",
      description: "Download media from a supported URL.",
      async execute(ctx) {
        await ctx.reply("yt-dlp download flow is scaffolded. Add your downloader/uploader adapter in services next.");
      },
    },
    {
      name: "autodl",
      aliases: ["dlauto", "ytdlpauto", "ydlauto"],
      cog: "ytdlp",
      description: "Toggle auto-download URL handling.",
      async execute(ctx) {
        await ctx.reply("Auto-download persistence is not wired yet.");
      },
    },
  ];
}
