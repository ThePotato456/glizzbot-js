import { toCurveText } from "../utils/format.js";
import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createUtilityCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "ping",
      description: "Ping the configured guild role or show latency.",
      async execute(ctx) {
        if (!ctx.guild) {
          await ctx.reply(`Pong. Gateway ping: ${bot.ws.ping}ms`);
          return;
        }
        const guildConfig = bot.configStore.getGuildConfig(bot.config, ctx.guild.id);
        await ctx.reply(guildConfig.pingRoleId ? `<@&${guildConfig.pingRoleId}>` : `Pong. Gateway ping: ${bot.ws.ping}ms`);
      },
    },
    {
      name: "curvetext",
      description: "Convert text to curve font.",
      async execute(ctx) {
        await ctx.reply(ctx.rawArgs ? toCurveText(ctx.rawArgs) : "Usage: curvetext <text>");
      },
    },
    {
      name: "google",
      description: "Return a Google search link.",
      async execute(ctx) {
        if (!ctx.rawArgs) {
          await ctx.reply("Usage: google <query>");
          return;
        }
        const url = `https://www.google.com/search?q=${encodeURIComponent(ctx.rawArgs)}`;
        await ctx.reply(url);
      },
    },
    {
      name: "servers",
      description: "List connected servers.",
      ownerOnly: true,
      async execute(ctx) {
        const lines = bot.guilds.cache.map((guild) => `${guild.name} (${guild.id})`);
        await ctx.reply(lines.join("\n") || "No guilds connected.");
      },
    },
  ];
}
