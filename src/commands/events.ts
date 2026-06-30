import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createEventCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "ufcevents",
      aliases: ["ufc"],
      cog: "events",
      description: "Preview upcoming UFC events.",
      async execute(ctx) {
        const events = await bot.events.listUpcomingUfcEvents();
        const lines = events.map((event) => `${event.title} - ${new Date(event.startsAt).toLocaleString()}`);
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "events",
      cog: "events",
      description: "Alias for ufcevents.",
      async execute(ctx) {
        const events = await bot.events.listUpcomingUfcEvents();
        const lines = events.map((event) => `${event.title} - ${new Date(event.startsAt).toLocaleString()}`);
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "scheduleufc",
      aliases: ["schedule"],
      cog: "events",
      description: "Stub scheduled-event creation entrypoint.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply("UFC scheduling is scaffolded here. Hook Discord scheduled-event creation into EventsService next.");
      },
    },
    {
      name: "clearufcevents",
      aliases: ["clearufc"],
      cog: "events",
      description: "Stub scheduled-event cleanup entrypoint.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply("UFC event cleanup is not wired to Discord scheduled events yet.");
      },
    },
  ];
}
