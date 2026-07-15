import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";
import { buildTrackEmbed, createMusicEmbed } from "./musicEmbeds.js";

const PLAYRANDOM_MAX = 10;
const QUEUE_PAGE_SIZE = 10;
const QUEUE_TITLE_MAX_LENGTH = 300;
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const DISCORD_MESSAGE_MAX_LENGTH = 2_000;
const TRUNCATION_NOTICE = "\n[diagnostics truncated]";

interface PlayrandomTarget {
  userId?: string;
  historyLabel: string;
}

interface PlayrandomRequest {
  amount: number;
  targetArg?: string;
}

export function fitDiscordMessage(content: string, maxLength = DISCORD_MESSAGE_MAX_LENGTH): string {
  if (content.length <= maxLength) {
    return content;
  }
  if (maxLength <= TRUNCATION_NOTICE.length) {
    return content.slice(0, maxLength);
  }
  return `${content.slice(0, maxLength - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

export function buildQueuePages(bot: GlizzBot, guildId: string): EmbedBuilder[] {
  const state = bot.music.getState(guildId);
  if (state.queue.length === 0) {
    return [createMusicEmbed("The queue is empty!")];
  }

  const totalPages = Math.ceil(state.queue.length / QUEUE_PAGE_SIZE);
  const pages: EmbedBuilder[] = [];

  for (let start = 0; start < state.queue.length; start += QUEUE_PAGE_SIZE) {
    const lines = state.queue.slice(start, start + QUEUE_PAGE_SIZE).map((item, offset) => {
      const title = item.title.length > QUEUE_TITLE_MAX_LENGTH
        ? `${item.title.slice(0, QUEUE_TITLE_MAX_LENGTH - 3)}...`
        : item.title;
      return `${start + offset + 1}. ${title}`;
    });
    const pageNumber = pages.length + 1;
    pages.push(
      createMusicEmbed(`**__Queue:__**\n${lines.join("\n")}`)
        .setFooter({
          text: `${state.queue.length} queued track(s) | Page ${pageNumber}/${totalPages}`,
        }),
    );
  }

  return pages;
}

function buildQueueComponents(pageIndex: number, totalPages: number) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("queue:prev")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIndex === 0),
      new ButtonBuilder()
        .setCustomId("queue:next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIndex >= totalPages - 1),
    ),
  ];
}

async function replyWithMusicEmbed(
  ctx: Parameters<BotCommand["execute"]>[0],
  embed: EmbedBuilder,
): Promise<void> {
  if ("send" in ctx.channel && typeof ctx.channel.send === "function") {
    await ctx.channel.send({ embeds: [embed] });
    return;
  }
  await ctx.message.reply({ embeds: [embed] });
}

function normalizeHistoryUrl(songRef: string): string | null {
  const normalized = String(songRef ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  return `https://www.youtube.com/watch?v=${normalized}`;
}

function describeUserName(
  user: { username?: string; globalName?: string | null; tag?: string } | null | undefined,
  fallbackId?: string,
): string {
  if (user?.globalName?.trim()) {
    return user.globalName.trim();
  }
  if (user?.username?.trim()) {
    return user.username.trim();
  }
  if (user?.tag?.includes("#")) {
    return user.tag.slice(0, user.tag.indexOf("#"));
  }
  if (user?.tag?.trim()) {
    return user.tag.trim();
  }
  return fallbackId ? `user ${fallbackId}` : "Unknown";
}

function parsePlayrandomRequest(ctx: Parameters<BotCommand["execute"]>[0]): PlayrandomRequest | null {
  if (ctx.args.length > 2) {
    return null;
  }

  const [firstArg, secondArg] = ctx.args;
  if (!firstArg) {
    return { amount: 1 };
  }

  if (isDiscordUserId(firstArg) && !secondArg) {
    return { amount: 1, targetArg: firstArg };
  }

  const parsedAmount = Number.parseInt(firstArg, 10);
  if (!Number.isNaN(parsedAmount) && String(parsedAmount) === firstArg) {
    return { amount: parsedAmount, targetArg: secondArg };
  }

  if (!secondArg) {
    return { amount: 1, targetArg: firstArg };
  }

  return null;
}

function parsePlayrandomTarget(
  ctx: Parameters<BotCommand["execute"]>[0],
  rawTarget: string | undefined,
): PlayrandomTarget | null {
  if (!rawTarget) {
    return {
      userId: ctx.message.author.id,
      historyLabel: `${describeUserName(ctx.message.author)}'s history`,
    };
  }

  if (rawTarget.toLowerCase() === "all") {
    return {
      historyLabel: "global history",
    };
  }

  const mentionMatch = rawTarget.match(/^<@!?(\d+)>$/);
  const mentionedUser = ctx.message.mentions.users.first?.() ?? null;
  if (mentionMatch) {
    const userId = mentionMatch[1];
    const labelSource = mentionedUser && mentionedUser.id === userId ? mentionedUser : null;
    return {
      userId,
      historyLabel: `${describeUserName(labelSource, userId)}'s history`,
    };
  }

  if (/^\d+$/.test(rawTarget)) {
    const cachedMember = ctx.guild && "members" in ctx.guild
      ? ctx.guild.members.cache.get(rawTarget)?.user
      : undefined;
    const cachedUser = ctx.message.client?.users.cache.get(rawTarget);
    return {
      userId: rawTarget,
      historyLabel: `${describeUserName(cachedMember ?? cachedUser, rawTarget)}'s history`,
    };
  }

  return null;
}

function isDiscordUserId(value: string): boolean {
  return /^\d{15,20}$/.test(value);
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
        await ctx.reply(fitDiscordMessage(lines.join("\n")));
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
            const embed = buildTrackEmbed("Now Playing", started);
            if (items.length > 1) {
              embed.setFooter({ text: `Queued ${items.length - 1} more track(s).` });
            }
            await replyWithMusicEmbed(ctx, embed);
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
      name: "playrandom",
      cog: "music",
      description: "Queue random songs from a user's history or global history.",
      guildOnly: true,
      async execute(ctx) {
        const request = parsePlayrandomRequest(ctx);
        if (!ctx.guild || !ctx.member || !request) {
          await ctx.reply("Usage: playrandom [number] [all|@user/user_id]");
          return;
        }

        const amount = request.amount;
        if (Number.isNaN(amount) || amount < 1) {
          await ctx.reply("Usage: playrandom [number] [all|@user/user_id]");
          return;
        }
        if (amount > PLAYRANDOM_MAX) {
          await ctx.reply(`You can only play up to ${PLAYRANDOM_MAX} random songs at a time!`);
          return;
        }

        const target = parsePlayrandomTarget(ctx, request.targetArg);
        if (!target) {
          await ctx.reply("Usage: playrandom [number] [all|@user/user_id]");
          return;
        }

        const historyRows = bot.music.getRandomHistory(amount, target.userId);
        if (historyRows.length === 0) {
          await ctx.reply(`No songs found in ${target.historyLabel}!`);
          return;
        }

        const queueItems = historyRows.flatMap((row) => {
          const url = normalizeHistoryUrl(row.song_url);
          if (!url) {
            return [];
          }
          return [{
            title: row.song_title || url,
            url,
            requestedBy: ctx.message.author.id,
            isResolved: false,
            sourceType: "url" as const,
            resolverNote: `Queued from ${target.historyLabel}. Stream will resolve before playback.`,
          }];
        });

        if (queueItems.length === 0) {
          await ctx.reply(`No playable songs found in ${target.historyLabel}!`);
          return;
        }

        await bot.music.ensureVoiceConnection(ctx.member, ctx.channel.id);
        const state = bot.music.getState(ctx.guild.id);
        const hadActiveTrack = Boolean(state.current);
        const queued = queueItems.map((item) => bot.music.enqueue(ctx.guild!.id, item));

        if (!hadActiveTrack) {
          const started = await bot.music.advancePlayback(ctx.guild.id, bot.musicResolver);
          if (!started) {
            await ctx.reply(`No playable songs found in ${target.historyLabel}!`);
            return;
          }
          const embed = buildTrackEmbed("Now Playing", started);
          if (queued.length > 1) {
            embed.setFooter({ text: `Queued ${queued.length - 1} more random track(s) from ${target.historyLabel}.` });
          }
          await replyWithMusicEmbed(ctx, embed);
          return;
        }

        await replyWithMusicEmbed(ctx, createMusicEmbed(`Queued ${queued.length} random song(s) from ${target.historyLabel}.`));
      },
    },
    {
      name: "queue",
      aliases: ["q"],
      cog: "music",
      description: "Show the queue.",
      guildOnly: true,
      async execute(ctx) {
        const pages = buildQueuePages(bot, ctx.guild!.id);
        let pageIndex = 0;
        const queueMessage = await ctx.message.reply({
          embeds: [pages[pageIndex]],
          components: pages.length > 1 ? buildQueueComponents(pageIndex, pages.length) : [],
        });

        if (pages.length === 1) {
          return;
        }

        const collector = queueMessage.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: QUEUE_TIMEOUT_MS,
        });

        collector.on("collect", async (interaction) => {
          if (interaction.user.id !== ctx.message.author.id) {
            await interaction.reply({
              content: "Only the person who ran `queue` can use these buttons.",
              ephemeral: true,
            }).catch(() => null);
            return;
          }

          pageIndex += interaction.customId === "queue:next" ? 1 : -1;
          pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
          await interaction.update({
            embeds: [pages[pageIndex]],
            components: buildQueueComponents(pageIndex, pages.length),
          }).catch(() => null);
        });

        collector.on("end", async () => {
          await queueMessage.edit({ components: [] }).catch(() => null);
        });
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
        if (next) {
          const state = bot.music.getState(ctx.guild!.id);
          const embed = buildTrackEmbed("Now Playing", next);
          if (state.queue.length > 0) {
            embed.setFooter({ text: `${state.queue.length} track(s) remaining in queue.` });
          }
          await replyWithMusicEmbed(ctx, embed);
        }
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
      description: "Insert a query at the top of the queue.",
      guildOnly: true,
      async execute(ctx) {
        const query = ctx.rawArgs.trim();
        if (!query) {
          await ctx.reply("Usage: insert <query>");
          return;
        }
        const resolved = await bot.musicResolver.resolveInput(query, ctx.message.author.id);
        const first = resolved.items[0];
        if (!first) {
          await ctx.reply(resolved.summary);
          return;
        }
        const item = bot.music.insert(ctx.guild!.id, 0, first);
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
