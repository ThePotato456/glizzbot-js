import { ChannelType, PermissionsBitField } from "discord.js";
import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createMusicCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "join",
      cog: "music",
      description: "Connect the bot to your voice channel.",
      guildOnly: true,
      async execute(ctx) {
        if (!ctx.member) {
          await ctx.reply("This command must be used from a guild member context.");
          return;
        }
        await bot.music.ensureVoiceConnection(ctx.member, ctx.channel.id);
        await ctx.reply(`Joined <#${ctx.member.voice.channelId}>.`);
      },
    },
    {
      name: "voicecheck",
      aliases: ["vc"],
      cog: "music",
      description: "Report the bot's current voice-channel diagnostics.",
      guildOnly: true,
      async execute(ctx) {
        if (!ctx.guild || !ctx.member?.voice.channel) {
          await ctx.reply("Join a voice channel first so I can inspect it.");
          return;
        }

        const voiceChannel = ctx.member.voice.channel;
        const botMember = ctx.guild.members.me;
        const permissions = botMember ? voiceChannel.permissionsFor(botMember) : null;
        const diagnostics = bot.music.getDiagnostics(ctx.guild.id).slice(-8);
        const lines = [
          `Channel: ${voiceChannel.name} (${voiceChannel.id})`,
          `Type: ${ChannelType[voiceChannel.type] ?? voiceChannel.type}`,
          `User count: ${voiceChannel.members.size}${"userLimit" in voiceChannel && voiceChannel.userLimit ? ` / ${voiceChannel.userLimit}` : ""}`,
          `Joinable: ${"joinable" in voiceChannel ? String(voiceChannel.joinable) : "unknown"}`,
          `Speakable: ${"speakable" in voiceChannel ? String(voiceChannel.speakable) : "unknown"}`,
          `Full: ${"full" in voiceChannel ? String(voiceChannel.full) : "unknown"}`,
          `ViewChannel: ${permissions ? String(permissions.has(PermissionsBitField.Flags.ViewChannel)) : "unknown"}`,
          `Connect: ${permissions ? String(permissions.has(PermissionsBitField.Flags.Connect)) : "unknown"}`,
          `Speak: ${permissions ? String(permissions.has(PermissionsBitField.Flags.Speak)) : "unknown"}`,
          `Gateway ping: ${bot.ws.ping}ms`,
          `Music state: ${bot.music.getVoiceSummary(ctx.guild.id)}`,
          diagnostics.length > 0 ? `Recent diagnostics:\n${diagnostics.join("\n")}` : "Recent diagnostics: none",
        ];
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "voiceenv",
      cog: "music",
      description: "Show installed Discord voice runtime dependencies.",
      async execute(ctx) {
        await ctx.reply(`\`\`\`\n${bot.music.getDependencyReport()}\n\`\`\``);
      },
    },
    {
      name: "leave",
      cog: "music",
      description: "Disconnect the bot from voice.",
      guildOnly: true,
      async execute(ctx) {
        bot.music.disconnect(ctx.guild!.id, "manual-leave");
        await ctx.reply("Disconnected from voice.");
      },
    },
    {
      name: "play",
      aliases: ["p"],
      cog: "music",
      description: "Play or queue a query or URL.",
      guildOnly: true,
      async execute(ctx) {
        if (!ctx.guild || !ctx.rawArgs) {
          await ctx.reply("Usage: play <query or url>");
          return;
        }
        if (!ctx.member) {
          await ctx.reply("This command must be used from a guild member context.");
          return;
        }
        const resolved = await bot.musicResolver.resolveInput(ctx.rawArgs, ctx.message.author.id);
        if (resolved.items.length === 0) {
          await ctx.reply(resolved.summary);
          return;
        }
        await bot.music.ensureVoiceConnection(ctx.member, ctx.channel.id);
        const items = resolved.items.map((item) => bot.music.enqueue(ctx.guild!.id, item));
        const state = bot.music.getState(ctx.guild.id);
        if (!state.current) {
          const started = await bot.music.advancePlayback(ctx.guild.id, bot.musicResolver);
          await ctx.reply(started ? `Queued and started: **${started.title}**\n${resolved.summary}` : resolved.summary);
          return;
        }
        await ctx.reply(`${resolved.summary}\nAdded ${items.length} item(s) to the queue.`);
      },
    },
    {
      name: "queue",
      aliases: ["q"],
      cog: "music",
      description: "Show the queue.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply(`${bot.music.getVoiceSummary(ctx.guild!.id)}\n${bot.music.queueSummary(ctx.guild!.id)}`);
      },
    },
    {
      name: "nowplaying",
      aliases: ["np"],
      cog: "music",
      description: "Show the active track.",
      guildOnly: true,
      async execute(ctx) {
        await ctx.reply(bot.music.describeNowPlaying(ctx.guild!.id));
      },
    },
    {
      name: "skip",
      aliases: ["s"],
      cog: "music",
      description: "Skip the current track.",
      guildOnly: true,
      async execute(ctx) {
        const next = await bot.music.skip(ctx.guild!.id, "manual-skip", bot.musicResolver);
        await ctx.reply(next ? `Skipped. Next up: **${next.title}**` : "Skipped. Queue is now empty.");
      },
    },
    {
      name: "stop",
      cog: "music",
      description: "Stop playback and clear the queue.",
      guildOnly: true,
      async execute(ctx) {
        bot.music.stop(ctx.guild!.id, "manual-stop");
        await ctx.reply("Stopped playback and cleared the queue. Idle disconnect will follow if enabled.");
      },
    },
    {
      name: "pause",
      cog: "music",
      description: "Pause the current track.",
      guildOnly: true,
      async execute(ctx) {
        const paused = bot.music.pause(ctx.guild!.id);
        await ctx.reply(paused ? "Paused playback." : "Nothing is currently playing that can be paused.");
      },
    },
    {
      name: "resume",
      cog: "music",
      description: "Resume the current track.",
      guildOnly: true,
      async execute(ctx) {
        const resumed = bot.music.resume(ctx.guild!.id);
        await ctx.reply(resumed ? "Resumed playback." : "Nothing is currently paused.");
      },
    },
    {
      name: "clear",
      cog: "music",
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
      cog: "music",
      description: "Shuffle the queue.",
      guildOnly: true,
      async execute(ctx) {
        bot.music.shuffle(ctx.guild!.id);
        await ctx.reply("Shuffled the queue.");
      },
    },
    {
      name: "remove",
      cog: "music",
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
      cog: "music",
      description: "Insert a query at a queue position.",
      guildOnly: true,
      async execute(ctx) {
        const index = Number.parseInt(ctx.args[0] ?? "", 10) - 1;
        const query = ctx.args.slice(1).join(" ");
        if (Number.isNaN(index) || !query) {
          await ctx.reply("Usage: insert <position> <query>");
          return;
        }
        const resolved = await bot.musicResolver.resolveInput(query, ctx.message.author.id);
        const first = resolved.items[0];
        if (!first) {
          await ctx.reply(resolved.summary);
          return;
        }
        const item = bot.music.insert(ctx.guild!.id, index, first);
        await ctx.reply(`Inserted **${item.title}** at position ${index + 1}.`);
      },
    },
    {
      name: "noleave",
      cog: "music",
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
      cog: "music",
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
      cog: "music",
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
