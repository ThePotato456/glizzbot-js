import test from "node:test";
import assert from "node:assert/strict";
import { PermissionsBitField } from "discord.js";
import { MusicService } from "../../src/services/musicService.js";
import type { QueueItem } from "../../src/types.js";

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

test("stop clears current track and pending queue", () => {
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
