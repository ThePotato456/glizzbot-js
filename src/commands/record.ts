import type { BotCommand } from "../types.js";

export function createRecordCommands(): BotCommand[] {
  return [
    {
      name: "vcrecord",
      description: "Start voice recording.",
      ownerOnly: true,
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply("Voice recording needs a Discord voice receive pipeline. This command is scaffolded for a future adapter.");
      },
    },
    {
      name: "stoprecord",
      description: "Stop voice recording.",
      ownerOnly: true,
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply("No active recording adapter is configured yet.");
      },
    },
  ];
}
