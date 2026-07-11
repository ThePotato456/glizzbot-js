import test from "node:test";
import assert from "node:assert/strict";
import type { VoiceTransportCallbacks } from "../../src/services/voice/voiceTransport.js";
import { PermissionsBitField } from "discord.js";
import { MusicService } from "../../src/services/musicService.js";
import type { QueueItem } from "../../src/types.js";
import { SongHistoryRepository } from "../../src/services/songHistoryRepository.js";
import { createTestRuntimePaths } from "../helpers/testRuntimePaths.js";
import fs from "node:fs";
import path from "node:path";

function createQueueItem(overrides: Partial<QueueItem> = {}): Omit<QueueItem, "id" | "addedAt"> {
  return {
    title: "Track",
    url: "https://example.com/watch?v=1",
    requestedBy: "user-1",
    isResolved: false,
    sourceType: "search",
    ...overrides,
  };
}

function resetRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}

test("advancePlayback promotes next queue item into current track", async () => {
  const service = new MusicService(1000, true, false);
  service.enqueue("guild-1", createQueueItem({ title: "First" }));

  const started = await service.advancePlayback("guild-1", {
    resolveQueueItem: async (item) => ({
      ...item,
      isResolved: true,
      streamUrl: "https://media.example/stream",
      resolverNote: "resolved in test",
    }),
  } as never);

  assert.ok(started);
  assert.equal(started?.title, "First");
  const state = service.getState("guild-1");
  assert.equal(state.current?.title, "First");
  assert.equal(state.current?.streamUrl, "https://media.example/stream");
  assert.equal(state.playbackStatus, "placeholder");
});

test("stop clears current track and pending queue", async () => {
  const service = new MusicService(1000, true, false);
  service.enqueue("guild-1", createQueueItem({ title: "One" }));
  service.enqueue("guild-1", createQueueItem({ title: "Two" }));
  const state = service.getState("guild-1");
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Now Playing", isResolved: true, streamUrl: "https://media.example/live" }),
  };

  service.stop("guild-1", "manual-stop");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.current, null);
  assert.equal(state.queue.length, 0);
  assert.equal(state.playbackStatus, "idle");
  assert.equal(state.lastStopReason, "manual-stop");
});

test("skip advances to the next queued track", async () => {
  const service = new MusicService(1000, true, false);
  const state = service.getState("guild-1");
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Now Playing", isResolved: true, streamUrl: "https://media.example/current" }),
  };
  service.enqueue("guild-1", createQueueItem({ title: "Second" }));
  service.enqueue("guild-1", createQueueItem({ title: "Third" }));

  const next = await service.skip("guild-1", "manual-skip", {
    resolveQueueItem: async (item) => ({
      ...item,
      isResolved: true,
      streamUrl: `https://media.example/${item.title.toLowerCase()}`,
    }),
  } as never);

  assert.ok(next);
  assert.equal(next?.title, "Second");
  assert.equal(state.current?.title, "Second");
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0]?.title, "Third");
  assert.equal(state.lastStopReason, "manual-skip");
});

test("pause and resume update guild playback state", () => {
  const service = new MusicService(1000, true, false);
  const state = service.getState("guild-1");
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Now Playing", isResolved: true, streamUrl: "https://media.example/current" }),
  };
  state.playbackStatus = "playing";

  const paused = service.pause("guild-1");
  assert.equal(paused, true);
  assert.equal(state.isPaused, true);
  assert.equal(state.playbackStatus, "paused");

  const resumed = service.resume("guild-1");
  assert.equal(resumed, true);
  assert.equal(state.isPaused, false);
  assert.equal(state.playbackStatus, "playing");
});

test("advancePlayback skips unplayable playlist placeholders and moves to next track", async () => {
  const service = new MusicService(1000, true, false);
  service.enqueue("guild-1", createQueueItem({
    title: "Playlist Placeholder",
    sourceType: "youtubePlaylist",
    isResolved: false,
    url: "https://www.youtube.com/watch?v=abc123&list=playlist42",
  }));
  service.enqueue("guild-1", createQueueItem({ title: "Playable Track" }));

  const started = await service.advancePlayback("guild-1", {
    resolveQueueItem: async (item) => {
      if (item.sourceType === "youtubePlaylist") {
        return {
          ...item,
          isResolved: true,
          resolverNote: "Playlist placeholder could not expand in test.",
        };
      }
      return {
        ...item,
        isResolved: true,
        streamUrl: "https://media.example/playable",
      };
    },
  } as never);

  assert.ok(started);
  assert.equal(started?.title, "Playable Track");
  const state = service.getState("guild-1");
  assert.equal(state.current?.title, "Playable Track");
  assert.equal(state.queue.length, 0);
  assert.equal(state.playbackStatus, "placeholder");
});

test("handlePlaybackFailure advances to the next queued track", async () => {
  const service = new MusicService(1000, true, false);
  const state = service.getState("guild-1");
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Broken Track", isResolved: true, streamUrl: "https://media.example/broken" }),
  };
  state.playbackStatus = "playing";
  service.enqueue("guild-1", createQueueItem({ title: "Recovery Track" }));

  const next = await service.handlePlaybackFailure("guild-1", "ffmpeg exited unexpectedly", {
    resolveQueueItem: async (item) => ({
      ...item,
      isResolved: true,
      streamUrl: "https://media.example/recovery",
    }),
  } as never);

  assert.ok(next);
  assert.equal(next?.title, "Recovery Track");
  assert.equal(state.current?.title, "Recovery Track");
  assert.equal(state.lastStopReason, "playback-failed");
  assert.match(state.incidentMarks.at(-1)?.note ?? "", /ffmpeg exited unexpectedly/);
});

test("handlePlaybackFailure leaves the guild idle when no fallback track exists", async () => {
  const service = new MusicService(1000, true, false);
  const state = service.getState("guild-1");
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Broken Track", isResolved: true, streamUrl: "https://media.example/broken" }),
  };
  state.playbackStatus = "playing";

  const next = await service.handlePlaybackFailure("guild-1", "stream disconnected");

  assert.equal(next, null);
  assert.equal(state.current, null);
  assert.equal(state.playbackStatus, "idle");
  assert.equal(state.lastStopReason, "playback-failed");
  assert.match(state.incidentMarks.at(-1)?.note ?? "", /stream disconnected/);
});

test("advancePlayback skips unplayable items instead of keeping them queued", async () => {
  const service = new MusicService(1000, true, false);
  service.enqueue("guild-1", createQueueItem({ title: "Retry Later", sourceType: "url" }));
  service.enqueue("guild-1", createQueueItem({ title: "Still Queued", sourceType: "url" }));

  const next = await service.advancePlayback("guild-1", {
    resolveQueueItem: async (item) => ({
      ...item,
      isResolved: false,
      resolverNote: `temporary failure for ${item.title}`,
    }),
  } as never);

  const state = service.getState("guild-1");
  assert.equal(next, null);
  assert.equal(state.current, null);
  assert.equal(state.queue.length, 0);
});

test("advancePlayback skips failed items and still progresses to a later playable track", async () => {
  const service = new MusicService(1000, true, false);
  service.enqueue("guild-1", createQueueItem({ title: "Retry Later", sourceType: "url" }));
  service.enqueue("guild-1", createQueueItem({ title: "Playable Next", sourceType: "url" }));

  const started = await service.advancePlayback("guild-1", {
    resolveQueueItem: async (item) => {
      if (item.title === "Retry Later") {
        return {
          ...item,
          isResolved: false,
          resolverNote: "temporary extractor failure",
        };
      }
      return {
        ...item,
        isResolved: true,
        streamUrl: "https://media.example/playable-next",
      };
    },
  } as never);

  const state = service.getState("guild-1");
  assert.ok(started);
  assert.equal(started?.title, "Playable Next");
  assert.equal(state.current?.title, "Playable Next");
  assert.equal(state.queue.length, 0);
});

test("buildFfmpegArgs forwards yt-dlp stream headers to ffmpeg input options", () => {
  const service = new MusicService(1000, true, false);

  const args = (service as any).buildFfmpegArgs({
    id: "q1",
    title: "Header Track",
    url: "https://example.com/watch?v=1",
    requestedBy: "user-1",
    isResolved: true,
    sourceType: "url",
    streamUrl: "https://media.example/stream",
    streamHeaders: {
      "User-Agent": "GlizzBot Test Agent",
      Referer: "https://example.com/",
    },
    addedAt: Date.now(),
  } satisfies QueueItem) as string[];

  assert.ok(args.includes("-user_agent"));
  assert.ok(args.includes("GlizzBot Test Agent"));
  const headersIndex = args.indexOf("-headers");
  assert.ok(headersIndex >= 0);
  assert.match(args[headersIndex + 1] ?? "", /Referer: https:\/\/example.com\//);
});

test("enqueue and insert do not record song history before playback begins", () => {
  const root = path.resolve("test-tmp", "music-service-history-queue-only");
  resetRoot(root);
  const paths = createTestRuntimePaths(root);
  const service = new MusicService(1000, true, false, {
    databaseFile: paths.databaseFile,
    legacyDatabaseFile: paths.legacyDatabaseFile,
  });

  service.enqueue("guild-1", createQueueItem({ title: "Queued Only" }));
  service.insert("guild-1", 0, createQueueItem({ title: "Inserted Only" }));

  const repository = new SongHistoryRepository(paths);
  const count = repository.countSongs();
  repository.close();

  assert.equal(count, 0);
});

test("successful playback start records song history", () => {
  const root = path.resolve("test-tmp", "music-service-history-playback");
  resetRoot(root);
  const paths = createTestRuntimePaths(root);
  const service = new MusicService(1000, true, false, {
    databaseFile: paths.databaseFile,
    legacyDatabaseFile: paths.legacyDatabaseFile,
  });

  (service as any).recordPlaybackHistory({
    title: "Played Track",
    url: "https://example.com/watch?v=played",
    requestedBy: "user-1",
    durationSeconds: 120,
  });

  const repository = new SongHistoryRepository(paths);
  const latest = repository.getLatestSong();
  repository.close();

  assert.ok(latest);
  assert.equal(latest?.song_title, "Played Track");
  assert.equal(latest?.song_url, "https://example.com/watch?v=played");
  assert.equal(latest?.user_id, "user-1");
});

test("stop schedules idle disconnect when the guild should leave and voice is connected", async () => {
  const service = new MusicService(20, true, false);
  const state = service.getState("guild-1");
  state.voiceChannelId = "voice-1";
  state.textChannelId = "text-1";
  state.connectionStatus = "connected";
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Now Playing", isResolved: true, streamUrl: "https://media.example/current" }),
  };

  let destroyCalls = 0;
  (service as any).sessions.set("guild-1", {
    connection: {
      destroy: () => {
        destroyCalls += 1;
      },
    },
    player: {
      stop: () => undefined,
    },
    idleTimer: null,
    ffmpeg: null,
  });

  service.stop("guild-1", "manual-stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.connectionStatus, "idle-disconnect-pending");

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(state.connectionStatus, "disconnected");
  assert.equal(state.voiceChannelId, null);
  assert.equal(destroyCalls, 1);
});

test("stop does not schedule idle disconnect when noleave behavior is active", async () => {
  const service = new MusicService(20, true, false);
  const state = service.getState("guild-1");
  state.voiceChannelId = "voice-1";
  state.textChannelId = "text-1";
  state.connectionStatus = "connected";
  state.shouldLeave = false;
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Now Playing", isResolved: true, streamUrl: "https://media.example/current" }),
  };

  let destroyCalls = 0;
  (service as any).sessions.set("guild-1", {
    connection: {
      destroy: () => {
        destroyCalls += 1;
      },
    },
    player: {
      stop: () => undefined,
    },
    idleTimer: null,
    ffmpeg: null,
  });

  service.stop("guild-1", "manual-stop");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(state.connectionStatus, "connected");
  assert.equal(state.voiceChannelId, "voice-1");
  assert.equal(destroyCalls, 0);
});

test("ensureVoiceConnection fails fast when the bot lacks connect permission", async () => {
  const service = new MusicService(1000, true, false);

  await assert.rejects(
    service.ensureVoiceConnection({
      guild: {
        id: "guild-1",
        members: {
          me: { id: "bot-1" },
        },
      },
      voice: {
        channel: {
          permissionsFor: () => ({
            has: (flag: bigint) => flag !== BigInt(PermissionsBitField.Flags.Connect),
          }),
        },
      },
    } as never),
    /do not have permission to connect/i,
  );
});

test("ensureVoiceConnection fails fast when Discord marks the channel as unjoinable", async () => {
  const service = new MusicService(1000, true, false);

  await assert.rejects(
    service.ensureVoiceConnection({
      guild: {
        id: "guild-1",
        members: {
          me: { id: "bot-1" },
        },
      },
      voice: {
        channel: {
          joinable: false,
          speakable: true,
          full: false,
          permissionsFor: () => ({
            has: () => true,
          }),
        },
      },
    } as never),
    /cannot join that voice channel/i,
  );
});

test("ensureVoiceConnection fails fast when the voice channel is full", async () => {
  const service = new MusicService(1000, true, false);

  await assert.rejects(
    service.ensureVoiceConnection({
      guild: {
        id: "guild-1",
        members: {
          me: { id: "bot-1" },
        },
      },
      voice: {
        channel: {
          joinable: true,
          speakable: true,
          full: true,
          permissionsFor: () => ({
            has: () => true,
          }),
        },
      },
    } as never),
    /voice channel is full/i,
  );
});

test("ensureVoiceConnection fails fast when the bot lacks speak permission", async () => {
  const service = new MusicService(1000, true, false);

  await assert.rejects(
    service.ensureVoiceConnection({
      guild: {
        id: "guild-1",
        members: {
          me: { id: "bot-1" },
        },
      },
      voice: {
        channel: {
          permissionsFor: () => ({
            has: (flag: bigint) => flag !== BigInt(PermissionsBitField.Flags.Speak),
          }),
        },
      },
    } as never),
    /do not have permission to speak/i,
  );
});

test("ensureVoiceConnection fails fast when the bot lacks view-channel permission", async () => {
  const service = new MusicService(1000, true, false);

  await assert.rejects(
    service.ensureVoiceConnection({
      guild: {
        id: "guild-1",
        members: {
          me: { id: "bot-1" },
        },
      },
      voice: {
        channel: {
          joinable: true,
          speakable: true,
          full: false,
          permissionsFor: () => ({
            has: (flag: bigint) => flag !== BigInt(PermissionsBitField.Flags.ViewChannel),
          }),
        },
      },
    } as never),
    /do not have permission to view/i,
  );
});

test("stale playback-finished callbacks do not clear the replacement track", async () => {
  let callbacks: VoiceTransportCallbacks | null = null;
  let disconnectReason: string | null = null;
  const transport = {
    guildId: "guild-1",
    channelId: "voice-1",
    connect: async () => undefined,
    disconnect: (reason?: string) => {
      disconnectReason = reason ?? null;
    },
    play: (_stream: unknown, _playbackId?: string | null) => undefined,
    pause: () => false,
    resume: () => false,
    stop: () => undefined,
    isConnected: () => true,
    getDebugState: () => "connected",
  };

  const service = new MusicService(
    1000,
    true,
    false,
    null,
    (_member, receivedCallbacks) => {
      callbacks = receivedCallbacks;
      return transport as never;
    },
  );

  await service.ensureVoiceConnection({
    guild: {
      id: "guild-1",
      members: {
        me: { id: "bot-1" },
      },
    },
    voice: {
      channel: {
        id: "voice-1",
        type: 2,
        joinable: true,
        speakable: true,
        full: false,
        name: "Voice",
        permissionsFor: () => ({
          has: () => true,
        }),
      },
    },
    client: {
      user: { id: "bot-1" },
    },
  } as never);

  service.getState("guild-1").textChannelId = "text-1";
  service.enqueue("guild-1", createQueueItem({ title: "First" }));
  service.enqueue("guild-1", createQueueItem({ title: "Second" }));

  const first = await service.advancePlayback("guild-1", {
    resolveQueueItem: async (item) => ({
      ...item,
      isResolved: true,
      streamUrl: `https://media.example/${item.title.toLowerCase()}`,
    }),
  } as never);
  assert.ok(first);

  const second = await service.skip("guild-1", "manual-skip", {
    resolveQueueItem: async (item) => ({
      ...item,
      isResolved: true,
      streamUrl: `https://media.example/${item.title.toLowerCase()}`,
    }),
  } as never);
  assert.ok(second);
  assert.equal(service.getState("guild-1").current?.title, "Second");

  callbacks?.onPlaybackFinished?.(first?.id ?? null);

  const state = service.getState("guild-1");
  assert.equal(state.current?.title, "Second");
  assert.equal(state.queue.length, 0);
  assert.equal(state.playbackStatus, "playing");
  assert.equal(disconnectReason, null);
});

test("disconnect forwards a labeled reason into voice teardown diagnostics", () => {
  const diagnostics: string[] = [];
  let receivedReason: string | null = null;
  const service = new MusicService(
    1000,
    true,
    false,
    null,
    () => ({
      guildId: "guild-1",
      channelId: "voice-1",
      connect: async () => undefined,
      disconnect: (reason?: string) => {
        receivedReason = reason ?? null;
      },
      play: () => undefined,
      pause: () => false,
      resume: () => false,
      stop: () => undefined,
      isConnected: () => true,
      getDebugState: () => "connected",
    }) as never,
  );
  service.attachDiagnosticMirror((_guildId, line) => {
    diagnostics.push(line);
  });

  (service as any).sessions.set("guild-1", {
    transport: {
      disconnect: (reason?: string) => {
        receivedReason = reason ?? null;
      },
      stop: () => undefined,
    },
    idleTimer: null,
    ffmpeg: null,
    encoder: null,
    playbackId: null,
  });

  service.disconnect("guild-1", "manual-leave");

  assert.equal(receivedReason, "manual-leave");
  assert.ok(diagnostics.some((line) => line.includes("Destroying voice connection (reason: manual-leave).")));
});

test("automatic playback failure notifies the track-finished handler with the replacement track", async () => {
  const service = new MusicService(1000, true, false);
  let announcedGuildId: string | null = null;
  let announcedTrackTitle: string | null = null;

  service.setTrackFinishedHandler(async (guildId, nextTrack) => {
    announcedGuildId = guildId;
    announcedTrackTitle = nextTrack?.title ?? null;
  });

  const state = service.getState("guild-1");
  state.current = {
    id: "current",
    addedAt: Date.now(),
    ...createQueueItem({ title: "Broken Track", isResolved: true, streamUrl: "https://media.example/broken" }),
  };
  state.playbackStatus = "playing";
  service.enqueue("guild-1", createQueueItem({
    title: "Replacement Track",
    isResolved: true,
    streamUrl: "https://media.example/replacement",
  }));

  await (service as any).handleAutomaticPlaybackFailure(
    "guild-1",
    "ffmpeg exited with code 1",
  );

  assert.equal(announcedGuildId, "guild-1");
  assert.equal(announcedTrackTitle, "Replacement Track");
  assert.equal(service.getState("guild-1").current?.title, "Replacement Track");
});
