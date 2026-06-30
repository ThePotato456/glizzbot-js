import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createWebCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "status",
      description: "Show the local web panel URL.",
      async execute(ctx) {
        await ctx.reply(`Web panel: http://localhost:${bot.config.webPanel.port}`);
      },
    },
  ];
}
