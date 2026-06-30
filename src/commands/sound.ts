import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createSoundCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "sounds",
      cog: "sound",
      description: "List available local sounds.",
      async execute(ctx) {
        const sounds = bot.sounds.listSounds();
        if (sounds.length === 0) {
          await ctx.reply("No sounds configured yet. Add entries to audio/sounds.json.");
          return;
        }
        await ctx.reply(sounds.map((sound) => `${sound.name} - ${sound.description ?? "no description"}`).join("\n"));
      },
    },
    {
      name: "playsound",
      cog: "sound",
      description: "Play a configured local sound.",
      guildOnly: true,
      async execute(ctx) {
        const sound = bot.sounds.getSound(ctx.rawArgs);
        await ctx.reply(sound ? `Sound playback scaffolded for **${sound.name}** (${sound.file}).` : "Unknown sound.");
      },
    },
  ];
}
