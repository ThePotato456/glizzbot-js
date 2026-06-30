import type { BotCommand, QueueItem } from "../types.js";
import type { GlizzBot } from "../bot.js";

function buildQueueItem(rawArgs: string, userId: string, sourceType: QueueItem["sourceType"]): Omit<QueueItem, "id" | "addedAt"> {
  return {
    title: rawArgs,
    url: rawArgs,
    requestedBy: userId,
    isResolved: sourceType !== "search",
    sourceType,
  };
}

export function createMusicCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "play",
      aliases: ["p"],
      description: "Queue a track or URL.",
      guildOnly: true,
      async execute(ctx) {
        if (!ctx.guild || !ctx.rawArgs) {
          await ctx.reply("Usage: play <query-or-url>");
          return;
        }
        const sourceType = /^https?:\/\//i.test(ctx.rawArgs) ? "url" : "search";
        const item = bot.music.enqueue(ctx.guild.id, buildQueueItem(ctx.rawArgs, ctx.message.author.id, sourceType));
        const state = bot.music.getState(ctx.guild.id);
        if (!state.current) {
          bot.music.startNext(ctx.guild.id);
          await ctx.reply(`Queued and started: **${item.title}**`);
          return;
        }
        await ctx.reply(`Queued: **${item.title}**`);
      },
    },
    {
      name: "queue",
      aliases: ["q"],
      description: "Show the queue.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply(bot.music.queueSummary(ctx.guild!.id));
      },
    },
    {
      name: "nowplaying",
      aliases: ["np"],
      description: "Show the active track.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply(bot.music.describeNowPlaying(ctx.guild!.id));
      },
    },
    {
      name: "skip",
      aliases: ["s"],
      description: "Skip the current track.",
      guildOnly: true,
      async execute(ctx) {
        const next = bot.music.skip(ctx.guild!.id, "manual-skip");
        await ctx.reply(next ? `Skipped. Next up: **${next.title}**` : "Skipped. Queue is now empty.");
      },
    },
    {
      name: "stop",
      description: "Stop playback and clear the queue.",
      guildOnly: true,
      async execute(ctx) {
        bot.music.stop(ctx.guild!.id, "manual-stop");
        await ctx.reply("Stopped playback and cleared the queue.");
      },
    },
    {
      name: "clear",
      description: "Clear queued tracks.",
      guildOnly: true,
      async execute(ctx) {
        const cleared = bot.music.clear(ctx.guild!.id);
        await ctx.reply(`Cleared ${cleared} queued track(s).`);
      },
    },
    {
      name: "shuffle",
      aliases: ["sh"],
      description: "Shuffle the queue.",
      guildOnly: true,
      async execute(ctx) {
        bot.music.shuffle(ctx.guild!.id);
        await ctx.reply("Shuffled the queue.");
      },
    },
    {
      name: "remove",
      description: "Remove a track by queue position.",
      guildOnly: true,
      async execute(ctx) {
        const index = Number.parseInt(ctx.args[0] ?? "", 10) - 1;
        const removed = bot.music.remove(ctx.guild!.id, index);
        await ctx.reply(removed ? `Removed **${removed.title}**.` : "Queue index out of range.");
      },
    },
    {
      name: "insert",
      description: "Insert a query at a queue position.",
      guildOnly: true,
      async execute(ctx) {
        const index = Number.parseInt(ctx.args[0] ?? "", 10) - 1;
        const query = ctx.args.slice(1).join(" ");
        if (Number.isNaN(index) || !query) {
          await ctx.reply("Usage: insert <position> <query>");
          return;
        }
        const item = bot.music.insert(ctx.guild!.id, index, buildQueueItem(query, ctx.message.author.id, "search"));
        await ctx.reply(`Inserted **${item.title}** at position ${index + 1}.`);
      },
    },
    {
      name: "noleave",
      description: "Toggle idle disconnect behavior.",
      guildOnly: true,
      async execute(ctx) {
        const state = bot.music.getState(ctx.guild!.id);
        state.shouldLeave = !state.shouldLeave;
        await ctx.reply(`Idle disconnect is now ${state.shouldLeave ? "enabled" : "disabled"}.`);
      },
    },
    {
      name: "timing",
      description: "Toggle music timing diagnostics for this guild.",
      guildOnly: true,
      async execute(ctx) {
        const state = bot.music.getState(ctx.guild!.id);
        state.timingDebug = !state.timingDebug;
        await ctx.reply(`Timing debug is now ${state.timingDebug ? "enabled" : "disabled"}.`);
      },
    },
    {
      name: "markaudio",
      description: "Bookmark the current audio state for diagnostics.",
      guildOnly: true,
      async execute(ctx) {
        const note = ctx.rawArgs || `Marked by ${ctx.message.author.tag}`;
        bot.music.mark(ctx.guild!.id, note);
        await ctx.reply("Marked the current music state for debug export.");
      },
    },
  ];
}
