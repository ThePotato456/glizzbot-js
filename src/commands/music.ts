import { ChannelType, EmbedBuilder, PermissionsBitField } from "discord.js";
import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";
import { formatDuration, toCurveText } from "../utils/format.js";

const MUSIC_EMBED_TITLE = toCurveText("MusicBot");

function createMusicEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(MUSIC_EMBED_TITLE)
    .setDescription(description);
}

function buildTrackEmbed(
  title: string,
  track: { title: string; requestedBy?: string; durationSeconds?: number },
): EmbedBuilder {
  return createMusicEmbed(`**__${title}:__**\n${title === "Now Playing" ? "\t\t" : ""}${track.title}`)
    .addFields(
      { name: toCurveText("Queued By"), value: track.requestedBy || "Unknown", inline: true },
      { name: toCurveText("Song Length"), value: formatDuration(track.durationSeconds), inline: true },
    );
}

function buildQueueEmbed(bot: GlizzBot, guildId: string): EmbedBuilder {
  const state = bot.music.getState(guildId);
  if (state.queue.length === 0) {
    return createMusicEmbed("The queue is empty!");
  }

  const lines = state.queue.map((item, index) => `${index + 1}. ${item.title}`);
  return createMusicEmbed(`**__Queue:__**\n${lines.join("\n")}`)
    .setFooter({ text: `${state.queue.length} queued track(s)` });
}

async function replyWithMusicEmbed(
  ctx: Parameters<BotCommand["execute"]>[0],
  embed: EmbedBuilder,
): Promise<void> {
  await ctx.message.reply({ embeds: [embed] });
}

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
        await replyWithMusicEmbed(ctx, createMusicEmbed(`Joined <#${ctx.member.voice.channelId}>.`));
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
        await replyWithMusicEmbed(ctx, createMusicEmbed("Disconnected from voice."));
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
          if (started) {
            await replyWithMusicEmbed(ctx, buildTrackEmbed("Now Playing", started));
          } else {
            await ctx.reply(resolved.summary);
          }
          return;
        }
        const firstItem = items[0];
        const embed = firstItem
          ? buildTrackEmbed("Queued Song", firstItem).setFooter({ text: `Added ${items.length} item(s) to the queue.` })
          : createMusicEmbed(`Added ${items.length} item(s) to the queue.`);
        await replyWithMusicEmbed(ctx, embed);
      },
    },
    {
      name: "queue",
      aliases: ["q"],
      cog: "music",
      description: "Show the queue.",
      guildOnly: true,
      async execute(ctx) {
        await replyWithMusicEmbed(ctx, buildQueueEmbed(bot, ctx.guild!.id));
      },
    },
    {
      name: "nowplaying",
      aliases: ["np"],
      cog: "music",
      description: "Show the active track.",
      guildOnly: true,
      async execute(ctx) {
        const state = bot.music.getState(ctx.guild!.id);
        if (!state.current) {
          await replyWithMusicEmbed(ctx, createMusicEmbed("Nothing is playing!"));
          return;
        }
        await replyWithMusicEmbed(ctx, buildTrackEmbed("Now Playing", state.current));
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
        await replyWithMusicEmbed(ctx, createMusicEmbed(next ? "Skipped current track!" : "Nothing is playing!"));
      },
    },
    {
      name: "stop",
      cog: "music",
      description: "Stop playback and clear the queue.",
      guildOnly: true,
      async execute(ctx) {
        bot.music.stop(ctx.guild!.id, "manual-stop");
        await replyWithMusicEmbed(ctx, createMusicEmbed("Stopped playback and cleared queue!"));
      },
    },
    {
      name: "pause",
      cog: "music",
      description: "Pause the current track.",
      guildOnly: true,
      async execute(ctx) {
        const paused = bot.music.pause(ctx.guild!.id);
        await replyWithMusicEmbed(ctx, createMusicEmbed(paused ? "Paused playback." : "Nothing is playing!"));
      },
    },
    {
      name: "resume",
      cog: "music",
      description: "Resume the current track.",
      guildOnly: true,
      async execute(ctx) {
        const resumed = bot.music.resume(ctx.guild!.id);
        await replyWithMusicEmbed(ctx, createMusicEmbed(resumed ? "Resumed playback." : "Nothing is playing!"));
      },
    },
    {
      name: "clear",
      cog: "music",
      description: "Clear queued tracks.",
      guildOnly: true,
      async execute(ctx) {
        const cleared = bot.music.clear(ctx.guild!.id);
        await replyWithMusicEmbed(
          ctx,
          createMusicEmbed(cleared > 0 ? "Cleared song queue!" : "The queue is empty!"),
        );
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
        await replyWithMusicEmbed(ctx, createMusicEmbed("Shuffled queue"));
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
        if (!removed) {
          await ctx.reply("Queue index out of range.");
          return;
        }
        await replyWithMusicEmbed(ctx, createMusicEmbed(`Removing: ${removed.title}`));
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
        await replyWithMusicEmbed(ctx, buildTrackEmbed("Inserted Next", item));
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
        await replyWithMusicEmbed(
          ctx,
          createMusicEmbed(state.shouldLeave ? "Bot will leave after queue finishes!" : "Bot will stay after queue finishes!"),
        );
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
        await replyWithMusicEmbed(
          ctx,
          createMusicEmbed(`Operation timing display ${state.timingDebug ? "enabled" : "disabled"}!`),
        );
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
        await replyWithMusicEmbed(ctx, createMusicEmbed("Marked current audio state for debug export."));
      },
    },
  ];
}
