import test from "node:test";
import assert from "node:assert/strict";
import { createMusicCommands } from "../../src/commands/music.js";
import type { BotCommand, CommandContext, MusicState, QueueItem } from "../../src/types.js";

interface ReplyRecord {
  content?: string;
  embeds?: Array<{ data?: { description?: string; footer?: { text?: string } } }>;
}

function createQueueItem(overrides: Partial<QueueItem> = {}): Omit<QueueItem, "id" | "addedAt"> {
  return {
    title: "Resolved Track",
    url: "https://example.com/watch?v=1",
    requestedBy: "user-1",
    isResolved: true,
    sourceType: "search",
    streamUrl: "https://media.example/stream",
    ...overrides,
  };
}

function createCommandContext(overrides: Partial<CommandContext> = {}) {
  const replies: ReplyRecord[] = [];
  const message = {
    author: { id: "user-1", tag: "tester#0001" },
    reply: async (payload: string | { embeds?: ReplyRecord["embeds"] }) => {
      if (typeof payload === "string") {
        replies.push({ content: payload });
      } else {
        replies.push({ embeds: payload.embeds });
      }
      return {} as never;
    },
  };
  const ctx: CommandContext = {
    message: message as never,
    args: [],
    rawArgs: "",
    guild: { id: "guild-1" } as never,
    member: { voice: { channelId: "voice-1" } } as never,
    channel: {
      id: "text-1",
      send: async (payload: string | { embeds?: ReplyRecord["embeds"] }) => {
        if (typeof payload === "string") {
          replies.push({ content: payload });
        } else {
          replies.push({ embeds: payload.embeds });
        }
        return {} as never;
      },
    } as never,
    reply: async (content: string) => {
      replies.push({ content });
      return {} as never;
    },
    ...overrides,
  };
  return { ctx, replies };
}

function createBotMock() {
  const state: MusicState = {
    guildId: "guild-1",
    queue: [],
    current: null,
    isPaused: false,
    voiceChannelId: null,
    textChannelId: null,
    connectionStatus: "disconnected",
    playbackStatus: "idle",
    shouldLeave: true,
    timingDebug: false,
    startedAt: null,
    lastStopReason: null,
    incidentMarks: [],
  };

  const calls = {
    ensureVoiceConnection: 0,
    resolveInput: 0,
    enqueue: 0,
    advancePlayback: 0,
    pause: 0,
    resume: 0,
    skip: 0,
  };

  const bot = {
    musicResolver: {
      resolveInput: async () => {
        calls.resolveInput += 1;
        return {
          items: [createQueueItem()],
          summary: "Resolved with yt-dlp: **Resolved Track**",
        };
      },
    },
    music: {
      ensureVoiceConnection: async () => {
        calls.ensureVoiceConnection += 1;
      },
      enqueue: (_guildId: string, item: Omit<QueueItem, "id" | "addedAt">) => {
        calls.enqueue += 1;
        return { id: "queued", addedAt: Date.now(), ...item };
      },
      getState: () => state,
      advancePlayback: async () => {
        calls.advancePlayback += 1;
        state.current = { id: "current", addedAt: Date.now(), ...createQueueItem() };
        return state.current;
      },
      pause: () => {
        calls.pause += 1;
        return true;
      },
      resume: () => {
        calls.resume += 1;
        return true;
      },
      skip: async () => {
        calls.skip += 1;
        return { id: "next", addedAt: Date.now(), ...createQueueItem({ title: "Next Track" }) };
      },
      getVoiceSummary: () => "voice summary",
      queueSummary: () => "queue summary",
      describeNowPlaying: () => "now playing",
      stop: () => undefined,
      clear: () => 0,
      shuffle: () => undefined,
      remove: () => null,
      insert: () => ({ id: "inserted", addedAt: Date.now(), ...createQueueItem() }),
      mark: () => undefined,
    },
  };

  return { bot: bot as never, state, calls };
}

function getCommand(commands: BotCommand[], name: string): BotCommand {
  const command = commands.find((candidate) => candidate.name === name);
  assert.ok(command, `Expected command ${name} to exist`);
  return command;
}

test("play replies with usage when no query or url is provided", async () => {
  const { bot } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "play");
  const { ctx, replies } = createCommandContext({ rawArgs: "" });

  await command.execute(ctx);

  assert.deepEqual(replies, [{ content: "Usage: play <query or url>" }]);
});

test("play connects, resolves, and starts playback when nothing is active", async () => {
  const { bot, calls } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "play");
  const { ctx, replies } = createCommandContext({ rawArgs: "test song" });

  await command.execute(ctx);

  assert.equal(calls.ensureVoiceConnection, 1);
  assert.equal(calls.resolveInput, 1);
  assert.equal(calls.enqueue, 1);
  assert.equal(calls.advancePlayback, 1);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "**__Now Playing:__**\n\t\tResolved Track");
});

test("play returns the resolver summary without joining voice when nothing is queueable", async () => {
  const { bot, calls } = createBotMock();
  bot.musicResolver.resolveInput = async () => {
    calls.resolveInput += 1;
    return {
      items: [],
      summary: "YouTube playlist URLs are not supported yet. Use a single video URL or a search query.",
    };
  };
  const command = getCommand(createMusicCommands(bot), "play");
  const { ctx, replies } = createCommandContext({ rawArgs: "https://www.youtube.com/watch?v=abc123&list=playlist42" });

  await command.execute(ctx);

  assert.equal(calls.resolveInput, 1);
  assert.equal(calls.ensureVoiceConnection, 0);
  assert.equal(calls.enqueue, 0);
  assert.equal(calls.advancePlayback, 0);
  assert.deepEqual(replies, [{ content: "YouTube playlist URLs are not supported yet. Use a single video URL or a search query." }]);
});

test("pause and resume commands return friendly success replies", async () => {
  const { bot, calls } = createBotMock();
  const commands = createMusicCommands(bot);
  const pause = getCommand(commands, "pause");
  const resume = getCommand(commands, "resume");
  const pauseCtx = createCommandContext();
  const resumeCtx = createCommandContext();

  await pause.execute(pauseCtx.ctx);
  await resume.execute(resumeCtx.ctx);

  assert.equal(calls.pause, 1);
  assert.equal(calls.resume, 1);
  assert.equal(pauseCtx.replies[0]?.embeds?.[0]?.data?.description, "Paused playback.");
  assert.equal(resumeCtx.replies[0]?.embeds?.[0]?.data?.description, "Resumed playback.");
});

test("skip replies with the next track title when one exists", async () => {
  const { bot, calls } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "skip");
  const { ctx, replies } = createCommandContext();

  await command.execute(ctx);

  assert.equal(calls.skip, 1);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "Skipped current track!");
  assert.equal(replies[1]?.embeds?.[0]?.data?.description, "**__Now Playing:__**\n\t\tNext Track");
});

test("play queues without advancing when a track is already active", async () => {
  const { bot, calls, state } = createBotMock();
  state.current = { id: "active", addedAt: Date.now(), ...createQueueItem({ title: "Already Playing" }) };
  const command = getCommand(createMusicCommands(bot), "play");
  const { ctx, replies } = createCommandContext({ rawArgs: "queued song" });

  await command.execute(ctx);

  assert.equal(calls.ensureVoiceConnection, 1);
  assert.equal(calls.resolveInput, 1);
  assert.equal(calls.enqueue, 1);
  assert.equal(calls.advancePlayback, 0);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "**__Queued Song:__**\nResolved Track");
  assert.equal(replies[0]?.embeds?.[0]?.data?.footer?.text, "Added 1 item(s) to the queue.");
});

test("play shows remaining queued tracks when a playlist starts immediately", async () => {
  const { bot, calls } = createBotMock();
  bot.musicResolver.resolveInput = async () => {
    calls.resolveInput += 1;
    return {
      items: [
        createQueueItem({ title: "Playlist One", url: "https://example.com/watch?v=1" }),
        createQueueItem({ title: "Playlist Two", url: "https://example.com/watch?v=2" }),
        createQueueItem({ title: "Playlist Three", url: "https://example.com/watch?v=3" }),
      ],
      summary: "Queued 3 track(s) from playlist: **Test Playlist**",
    };
  };
  bot.music.advancePlayback = async () => {
    calls.advancePlayback += 1;
    return { id: "current", addedAt: Date.now(), ...createQueueItem({ title: "Playlist One" }) };
  };
  const command = getCommand(createMusicCommands(bot), "play");
  const { ctx, replies } = createCommandContext({ rawArgs: "https://www.youtube.com/watch?v=1&list=abc" });

  await command.execute(ctx);

  assert.equal(calls.enqueue, 3);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "**__Now Playing:__**\n\t\tPlaylist One");
  assert.equal(replies[0]?.embeds?.[0]?.data?.footer?.text, "Queued 2 more track(s).");
});

test("skip reports an empty queue when nothing else can play", async () => {
  const { bot, calls } = createBotMock();
  bot.music.skip = async () => {
    calls.skip += 1;
    return null;
  };
  const command = getCommand(createMusicCommands(bot), "skip");
  const { ctx, replies } = createCommandContext();

  await command.execute(ctx);

  assert.equal(calls.skip, 1);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "Nothing is playing!");
});
