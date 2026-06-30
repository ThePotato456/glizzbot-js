import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createManagerCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "listcogs",
      cog: "manager",
      description: "List enabled cogs.",
      ownerOnly: true,
      async execute(ctx) {
        await ctx.reply(`Enabled cogs: ${bot.config.enabledCogs.join(", ")}`);
      },
    },
    {
      name: "reloadall",
      cog: "manager",
      description: "Rebuild the in-memory command registry.",
      ownerOnly: true,
      async execute(ctx) {
        await ctx.reply("Command modules are statically loaded in this Node rewrite. Restart the bot to reload code.");
      },
    },
  ];
}
