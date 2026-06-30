import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createHelpCommand(bot: GlizzBot): BotCommand {
  return {
    name: "help",
    description: "List bot commands.",
    async execute(ctx) {
      const unique = new Map<string, BotCommand>();
      for (const command of bot.commands.values()) {
        unique.set(command.name, command);
      }
      const lines = [...unique.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((command) => `\`${bot.config.prefix}${command.name}\` - ${command.description}`);
      await ctx.reply(lines.join("\n"));
    },
  };
}
