import test from "node:test";
import assert from "node:assert/strict";
import { buildQueuePages, createMusicCommands } from "../../src/commands/music.js";
import type { BotCommand, CommandContext, MusicState, QueueItem } from "../../src/types.js";

interface ReplyRecord {
  content?: string;
  embeds?: Array<{ data?: { description?: string; footer?: { text?: string } } }>;
}

interface SongHistoryRow {
  song_title: string;
  song_url: string;
  user_id: string;
  duration: string;
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
    author: { id: "user-1", tag: "tester#0001", username: "tester" },
    mentions: {
      users: {
        first: () => null,
      },
    },
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
    getRandomHistory: 0,
    insertIndex: null as number | null,
  };

  const randomHistory: SongHistoryRow[] = [
    {
      song_title: "History Track",
      song_url: "https://example.com/watch?v=history",
      user_id: "user-1",
      duration: "03:21",
    },
  ];

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
      getRandomHistory: () => {
        calls.getRandomHistory += 1;
        return randomHistory;
      },
      getVoiceSummary: () => "voice summary",
      queueSummary: () => "queue summary",
      describeNowPlaying: () => "now playing",
      stop: () => undefined,
      clear: () => 0,
      shuffle: () => undefined,
      remove: () => null,
      insert: (_guildId: string, index: number, item: Omit<QueueItem, "id" | "addedAt">) => {
        calls.insertIndex = index;
        return { id: "inserted", addedAt: Date.now(), ...item };
      },
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

test("queue embeds paginate tracks and preserve their queue positions", () => {
  const { bot, state } = createBotMock();
  state.queue = Array.from({ length: 23 }, (_, index) => ({
    id: `queue-${index + 1}`,
    addedAt: Date.now(),
    ...createQueueItem({ title: `Track ${index + 1}` }),
  }));

  const pages = buildQueuePages(bot, state.guildId);

  assert.equal(pages.length, 3);
  assert.match(pages[0]?.data.description ?? "", /1\. Track 1/);
  assert.match(pages[1]?.data.description ?? "", /11\. Track 11/);
  assert.match(pages[2]?.data.description ?? "", /23\. Track 23/);
  assert.equal(pages[2]?.data.footer?.text, "23 queued track(s) | Page 3/3");
});

test("queue embeds truncate unusually long titles below Discord's description limit", () => {
  const { bot, state } = createBotMock();
  state.queue = Array.from({ length: 10 }, (_, index) => ({
    id: `queue-${index + 1}`,
    addedAt: Date.now(),
    ...createQueueItem({ title: `Track ${index + 1} ${"x".repeat(5_000)}` }),
  }));

  const [page] = buildQueuePages(bot, state.guildId);

  assert.ok((page?.data.description?.length ?? Number.POSITIVE_INFINITY) < 4_096);
  assert.match(page?.data.description ?? "", /\.\.\./);
});

test("queue pagination restricts controls, navigates pages, and removes expired buttons", async () => {
  const { bot, state } = createBotMock();
  state.queue = Array.from({ length: 11 }, (_, index) => ({
    id: `queue-${index + 1}`,
    addedAt: Date.now(),
    ...createQueueItem({ title: `Track ${index + 1}` }),
  }));

  let collectHandler: ((interaction: {
    user: { id: string };
    customId: string;
    reply: (payload: unknown) => Promise<void>;
    update: (payload: { embeds: Array<{ data?: { description?: string } }> }) => Promise<void>;
  }) => Promise<void>) | undefined;
  let endHandler: (() => Promise<void>) | undefined;
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const updates: Array<{ embeds: Array<{ data?: { description?: string } }> }> = [];
  const queueMessage = {
    createMessageComponentCollector: () => ({
      on: (event: string, handler: unknown) => {
        if (event === "collect") {
          collectHandler = handler as typeof collectHandler;
        } else if (event === "end") {
          endHandler = handler as typeof endHandler;
        }
      },
    }),
    edit: async (payload: unknown) => {
      edits.push(payload);
    },
  };
  const message = {
    author: { id: "user-1", tag: "tester#0001", username: "tester" },
    mentions: { users: { first: () => null } },
    reply: async () => queueMessage,
  };
  const { ctx } = createCommandContext({ message: message as never });
  const command = getCommand(createMusicCommands(bot), "queue");

  await command.execute(ctx);
  assert.ok(collectHandler);
  assert.ok(endHandler);

  await collectHandler({
    user: { id: "someone-else" },
    customId: "queue:next",
    reply: async (payload) => { replies.push(payload); },
    update: async (payload) => { updates.push(payload); },
  });
  assert.equal(replies.length, 1);
  assert.equal(updates.length, 0);

  await collectHandler({
    user: { id: "user-1" },
    customId: "queue:next",
    reply: async (payload) => { replies.push(payload); },
    update: async (payload) => { updates.push(payload); },
  });
  assert.match(updates[0]?.embeds[0]?.data?.description ?? "", /11\. Track 11/);

  await endHandler();
  assert.deepEqual(edits, [{ components: [] }]);
});

test("play replies with usage when no query or url is provided", async () => {
  const { bot } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "play");
  const { ctx, replies } = createCommandContext({ rawArgs: "" });

  await command.execute(ctx);

  assert.deepEqual(replies, [{ content: "Usage: play <query or url>" }]);
});

test("playrandom replies with usage when the amount is missing or invalid", async () => {
  const { bot } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "playrandom");
  const invalid = createCommandContext({ args: ["abc"] });

  await command.execute(invalid.ctx);

  assert.deepEqual(invalid.replies, [{ content: "Usage: playrandom [number] [all|@user/user_id]" }]);
});

test("playrandom defaults to one song from the caller history", async () => {
  const { bot, calls } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "playrandom");
  const { ctx, replies } = createCommandContext({ args: [] });
  bot.music.getRandomHistory = (amount: number, userId?: string) => {
    calls.getRandomHistory += 1;
    assert.equal(amount, 1);
    assert.equal(userId, "user-1");
    return [
      {
        song_title: "Default History Track",
        song_url: "https://example.com/watch?v=default",
        user_id: "user-1",
        duration: "01:23",
      },
    ];
  };
  bot.music.advancePlayback = async () => {
    calls.advancePlayback += 1;
    return { id: "current", addedAt: Date.now(), ...createQueueItem({ title: "Default History Track" }) };
  };

  await command.execute(ctx);

  assert.equal(calls.getRandomHistory, 1);
  assert.equal(calls.enqueue, 1);
  assert.equal(calls.advancePlayback, 1);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "**__Now Playing:__**\n\t\tDefault History Track");
});

test("playrandom queues songs from the caller history by default and starts playback", async () => {
  const { bot, calls } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "playrandom");
  const { ctx, replies } = createCommandContext({ args: ["2"] });
  bot.music.getRandomHistory = (amount: number, userId?: string) => {
    calls.getRandomHistory += 1;
    assert.equal(amount, 2);
    assert.equal(userId, "user-1");
    return [
      {
        song_title: "History One",
        song_url: "abc123",
        user_id: "user-1",
        duration: "03:21",
      },
      {
        song_title: "History Two",
        song_url: "https://example.com/watch?v=2",
        user_id: "user-1",
        duration: "02:10",
      },
    ];
  };
  bot.music.advancePlayback = async () => {
    calls.advancePlayback += 1;
    return { id: "current", addedAt: Date.now(), ...createQueueItem({ title: "History One" }) };
  };

  await command.execute(ctx);

  assert.equal(calls.getRandomHistory, 1);
  assert.equal(calls.ensureVoiceConnection, 1);
  assert.equal(calls.enqueue, 2);
  assert.equal(calls.advancePlayback, 1);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "**__Now Playing:__**\n\t\tHistory One");
  assert.equal(replies[0]?.embeds?.[0]?.data?.footer?.text, "Queued 1 more random track(s) from tester's history.");
});

test("playrandom can target global history with all", async () => {
  const { bot, calls, state } = createBotMock();
  state.current = { id: "active", addedAt: Date.now(), ...createQueueItem({ title: "Already Playing" }) };
  const command = getCommand(createMusicCommands(bot), "playrandom");
  const { ctx, replies } = createCommandContext({ args: ["all"] });
  bot.music.getRandomHistory = (amount: number, userId?: string) => {
    calls.getRandomHistory += 1;
    assert.equal(amount, 1);
    assert.equal(userId, undefined);
    return [
      {
        song_title: "Global Track",
        song_url: "https://example.com/watch?v=global",
        user_id: "user-2",
        duration: "02:22",
      },
    ];
  };

  await command.execute(ctx);

  assert.equal(calls.getRandomHistory, 1);
  assert.equal(calls.advancePlayback, 0);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "Queued 1 random song(s) from global history.");
});

test("playrandom treats a lone user id as the target with a default amount of one", async () => {
  const { bot, calls, state } = createBotMock();
  state.current = { id: "active", addedAt: Date.now(), ...createQueueItem({ title: "Already Playing" }) };
  const command = getCommand(createMusicCommands(bot), "playrandom");
  const { ctx, replies } = createCommandContext({ args: ["123456789012345678"] });
  bot.music.getRandomHistory = (amount: number, userId?: string) => {
    calls.getRandomHistory += 1;
    assert.equal(amount, 1);
    assert.equal(userId, "123456789012345678");
    return [
      {
        song_title: "Target User Track",
        song_url: "https://example.com/watch?v=target",
        user_id: "123456789012345678",
        duration: "02:22",
      },
    ];
  };

  await command.execute(ctx);

  assert.equal(calls.getRandomHistory, 1);
  assert.equal(calls.advancePlayback, 0);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "Queued 1 random song(s) from user 123456789012345678's history.");
});

test("playrandom can target a mentioned user and queues without advancing when something is already active", async () => {
  const { bot, calls, state } = createBotMock();
  state.current = { id: "active", addedAt: Date.now(), ...createQueueItem({ title: "Already Playing" }) };
  bot.music.getRandomHistory = (amount: number, userId?: string) => {
    calls.getRandomHistory += 1;
    assert.equal(amount, 1);
    assert.equal(userId, "123456789012345678");
    return [
      {
        song_title: "Mentioned Track",
        song_url: "https://example.com/watch?v=mentioned",
        user_id: "123456789012345678",
        duration: "03:33",
      },
    ];
  };
  const { ctx, replies } = createCommandContext({
    args: ["1", "<@123456789012345678>"],
    message: {
      author: { id: "user-1", tag: "tester#0001", username: "tester" },
      mentions: {
        users: {
          first: () => ({ id: "123456789012345678", username: "friend" }),
        },
      },
      reply: async () => ({} as never),
    } as never,
  });
  const command = getCommand(createMusicCommands(bot), "playrandom");

  await command.execute(ctx);

  assert.equal(calls.getRandomHistory, 1);
  assert.equal(calls.advancePlayback, 0);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "Queued 1 random song(s) from friend's history.");
});

test("insert places a resolved query at the top of the queue", async () => {
  const { bot, calls } = createBotMock();
  const command = getCommand(createMusicCommands(bot), "insert");
  const { ctx, replies } = createCommandContext({
    args: ["some", "song"],
    rawArgs: "some song",
  });

  await command.execute(ctx);

  assert.equal(calls.resolveInput, 1);
  assert.equal(calls.insertIndex, 0);
  assert.equal(replies[0]?.embeds?.[0]?.data?.description, "**__Inserted Next:__**\nResolved Track");
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
