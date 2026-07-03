import type { BotCommand } from "../types.js";

export function createSoundCommands(): BotCommand[] {
  return [
    {
      name: "sounds",
      cog: "sound",
      description: "Deprecated soundboard command.",
      async execute(ctx) {
        await ctx.reply("The soundboard has been retired. Use `play <query or url>` for music playback.");
      },
    },
    {
      name: "playsound",
      cog: "sound",
      description: "Deprecated soundboard command.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply("The soundboard has been retired. Use `play <query or url>` for music playback.");
      },
    },
  ];
}
