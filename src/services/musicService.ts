import crypto from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { DAVE_PROTOCOL_VERSION, VERSION as DAVEY_VERSION } from "@snazzah/davey";
import { generateDependencyReport } from "@discordjs/voice";
import { opus } from "prism-media";
import { ChannelType, PermissionsBitField, type GuildMember } from "discord.js";
import type { MusicState, QueueItem } from "../types.js";
import type { RuntimePaths } from "../types.js";
import { formatDuration } from "../utils/format.js";
import type { MusicResolverService } from "./musicResolverService.js";
import { SongHistoryRepository, type SongHistoryRow } from "./songHistoryRepository.js";
import { DaveVoiceTransport } from "./voice/daveVoiceTransport.js";
import type { VoiceTransport, VoiceTransportFactory } from "./voice/voiceTransport.js";

interface GuildVoiceSession {
  transport: VoiceTransport;
  idleTimer: NodeJS.Timeout | null;
  ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null;
  encoder: Readable | null;
  playbackId: string | null;
}

export class MusicService {
  private readonly states = new Map<string, MusicState>();
  private readonly sessions = new Map<string, GuildVoiceSession>();
  private readonly diagnostics = new Map<string, string[]>();
  private readonly operationChains = new Map<string, Promise<unknown>>();
  private onTrackFinished: ((guildId: string, nextTrack: QueueItem | null) => Promise<void>) | null = null;
  private readonly songHistory: SongHistoryRepository | null;
  private readonly ffmpegPath: string;
  private resolver: MusicResolverService | null = null;
  private diagnosticMirror: ((guildId: string, message: string) => void) | null = null;

  constructor(
    private readonly idleDisconnectMs: number,
    private readonly defaultShouldLeave: boolean,
    private readonly defaultTimingDebug: boolean,
    runtimePaths: { databaseFile: RuntimePaths["databaseFile"]; legacyDatabaseFile?: string | null; ffmpegPath?: string } | null = null,
    private readonly transportFactory: VoiceTransportFactory = (member, callbacks) =>
      new DaveVoiceTransport(member, callbacks),
  ) {
    this.songHistory = runtimePaths ? new SongHistoryRepository(runtimePaths) : null;
    this.ffmpegPath = runtimePaths?.ffmpegPath || "ffmpeg";
  }

  getState(guildId: string): MusicState {
    let state = this.states.get(guildId);
    if (!state) {
      state = {
        guildId,
        queue: [],
        current: null,
        isPaused: false,
        voiceChannelId: null,
        textChannelId: null,
        connectionStatus: "disconnected",
        playbackStatus: "idle",
        shouldLeave: this.defaultShouldLeave,
        timingDebug: this.defaultTimingDebug,
        startedAt: null,
        lastStopReason: null,
        incidentMarks: [],
      };
      this.states.set(guildId, state);
    }
    return state;
  }

  setTrackFinishedHandler(handler: (guildId: string, nextTrack: QueueItem | null) => Promise<void>): void {
    this.onTrackFinished = handler;
  }

  attachResolver(resolver: MusicResolverService): void {
    this.resolver = resolver;
  }

  attachDiagnosticMirror(mirror: (guildId: string, message: string) => void): void {
    this.diagnosticMirror = mirror;
  }

  enqueue(guildId: string, item: Omit<QueueItem, "id" | "addedAt">): QueueItem {
    const state = this.getState(guildId);
    const queueItem: QueueItem = {
      ...item,
      id: crypto.randomUUID(),
      addedAt: Date.now(),
    };
    state.queue.push(queueItem);
    this.songHistory?.recordTrack(queueItem);
    return queueItem;
  }

  async playImmediate(
    guildId: string,
    item: Omit<QueueItem, "id" | "addedAt">,
    resolver?: MusicResolverService,
  ): Promise<QueueItem | null> {
    return this.runGuildOperation(guildId, async () => {
      const state = this.getState(guildId);
      if (state.current) {
        state.queue.unshift(this.materializeQueueItem(item));
        return this.skipInternal(guildId, "immediate-play", this.getResolver(resolver));
      }

      state.current = this.materializeQueueItem(item);
      state.startedAt = Date.now();
      state.isPaused = false;
      state.playbackStatus = "placeholder";
      this.cancelIdleDisconnect(guildId);
      this.startCurrentTrack(guildId);
      return state.current;
    });
  }

  async ensureVoiceConnection(member: GuildMember, textChannelId?: string): Promise<void> {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error("Join a voice channel first.");
    }

    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      throw new Error("Stage voice channels are not supported yet. Join a regular voice channel and try again.");
    }

    if ("full" in voiceChannel && voiceChannel.full) {
      throw new Error("Your voice channel is full, so I cannot join it.");
    }

    if ("joinable" in voiceChannel && voiceChannel.joinable === false) {
      throw new Error("Discord reports that I cannot join that voice channel.");
    }

    if ("speakable" in voiceChannel && voiceChannel.speakable === false) {
      throw new Error("Discord reports that I cannot speak in that voice channel.");
    }

    const botMember = member.guild.members.me;
    if (botMember) {
      const permissions = voiceChannel.permissionsFor(botMember);
      if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
        throw new Error("I do not have permission to view that voice channel.");
      }
      if (!permissions?.has(PermissionsBitField.Flags.Connect)) {
        throw new Error("I do not have permission to connect to that voice channel.");
      }
      if (!permissions.has(PermissionsBitField.Flags.Speak)) {
        throw new Error("I do not have permission to speak in that voice channel.");
      }
    }

    const guildId = member.guild.id;
    const state = this.getState(guildId);
    this.recordDiagnostic(
      guildId,
      `Attempting voice join for channel ${voiceChannel.name} (${voiceChannel.id}). joinable=${"joinable" in voiceChannel ? String(voiceChannel.joinable) : "unknown"} speakable=${"speakable" in voiceChannel ? String(voiceChannel.speakable) : "unknown"} full=${"full" in voiceChannel ? String(voiceChannel.full) : "unknown"}`,
    );
    this.cancelIdleDisconnect(guildId);
    state.connectionStatus = "connecting";
    state.voiceChannelId = voiceChannel.id;
    state.textChannelId = textChannelId ?? state.textChannelId;

    const existing = this.sessions.get(guildId);
    if (
      existing
      && existing.transport.channelId === voiceChannel.id
      && existing.transport.isConnected()
    ) {
      state.connectionStatus = "connected";
      return;
    }

    if (existing) {
      this.clearSession(guildId, true);
    }

    let session: GuildVoiceSession | null = null;

    const transport = this.transportFactory(member, {
      onDiagnostic: (message) => {
        this.recordDiagnostic(guildId, message);
      },
      onConnectionStateChange: (status) => {
        const currentState = this.getState(guildId);
        currentState.connectionStatus = status;
        if (status === "disconnected") {
          const active = this.sessions.get(guildId);
          if (active?.transport === transport) {
            this.stopSessionPlayback(active);
            this.sessions.delete(guildId);
          }
          currentState.current = null;
          currentState.startedAt = null;
          currentState.voiceChannelId = null;
          currentState.textChannelId = null;
          currentState.playbackStatus = "idle";
          currentState.isPaused = false;
        }
      },
      onPlaybackStateChange: (status) => {
        const currentState = this.getState(guildId);
        currentState.playbackStatus = status;
        currentState.isPaused = status === "paused";
      },
      onPlaybackFinished: (playbackId) => {
        if (!session || !playbackId || session.playbackId !== playbackId) {
          return;
        }
        void this.handleTransportPlaybackFinished(guildId, playbackId);
      },
      onPlaybackError: (error, playbackId) => {
        if (!session || !playbackId || session.playbackId !== playbackId) {
          return;
        }
        void this.handleTransportPlaybackError(guildId, playbackId, error.message);
      },
      shouldLogTimingDebug: () => this.getState(guildId).timingDebug,
    });

    session = {
      transport,
      idleTimer: null,
      ffmpeg: null,
      encoder: null,
      playbackId: null,
    };

    this.sessions.set(guildId, session);

    try {
      await transport.connect();
      state.connectionStatus = "connected";
      this.recordDiagnostic(guildId, "Voice connection reached Ready.");
    } catch (error) {
      this.sessions.delete(guildId);
      state.connectionStatus = "disconnected";
      state.voiceChannelId = null;
      state.textChannelId = null;
      state.playbackStatus = "idle";
      state.lastStopReason = "voice-connect-failed";

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("4017")) {
        throw new Error(
          "Discord rejected the voice connection because this channel requires DAVE end-to-end encryption and the custom DAVE transport did not finish negotiating it.",
          { cause: error instanceof Error ? error : undefined },
        );
      }

      throw new Error(
        `Could not connect to your voice channel before timeout. Last transport error: ${message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  disconnect(guildId: string, reason = "manual-disconnect"): void {
    const state = this.getState(guildId);
    state.lastStopReason = reason;
    state.current = null;
    state.startedAt = null;
    state.voiceChannelId = null;
    state.textChannelId = null;
    state.connectionStatus = "disconnected";
    state.playbackStatus = "idle";
    state.isPaused = false;
    this.clearSession(guildId, true);
  }

  getVoiceSummary(guildId: string): string {
    const session = this.sessions.get(guildId);
    if (session) {
      return session.transport.getDebugState();
    }

    const state = this.getState(guildId);
    if (!state.voiceChannelId) {
      return "Not connected to voice.";
    }
    return `Voice channel: <#${state.voiceChannelId}> | connection: ${state.connectionStatus} | playback: ${state.playbackStatus}`;
  }

  async advancePlayback(guildId: string, resolver?: MusicResolverService): Promise<QueueItem | null> {
    return this.runGuildOperation(guildId, async () =>
      this.advancePlaybackInternal(guildId, this.getResolver(resolver)));
  }

  async skip(guildId: string, reason: string, resolver?: MusicResolverService): Promise<QueueItem | null> {
    return this.runGuildOperation(guildId, async () =>
      this.skipInternal(guildId, reason, this.getResolver(resolver)));
  }

  pause(guildId: string): boolean {
    const state = this.getState(guildId);
    if (!state.current || state.isPaused) {
      return false;
    }

    const session = this.sessions.get(guildId);
    session?.transport.pause();
    state.isPaused = true;
    state.playbackStatus = "paused";
    return true;
  }

  resume(guildId: string): boolean {
    const state = this.getState(guildId);
    if (!state.current || !state.isPaused) {
      return false;
    }

    const session = this.sessions.get(guildId);
    session?.transport.resume();
    state.isPaused = false;
    state.playbackStatus = "playing";
    return true;
  }

  async handlePlaybackFailure(
    guildId: string,
    reason: string,
    resolver?: MusicResolverService,
  ): Promise<QueueItem | null> {
    return this.runGuildOperation(guildId, async () =>
      this.handlePlaybackFailureInternal(guildId, reason, this.getResolver(resolver)));
  }

  stop(guildId: string, reason: string): void {
    void this.runGuildOperation(guildId, async () => {
      const state = this.getState(guildId);
      state.lastStopReason = reason;
      state.current = null;
      state.queue = [];
      state.startedAt = null;
      state.isPaused = false;
      state.playbackStatus = "idle";
      const session = this.sessions.get(guildId);
      if (session) {
        this.stopSessionPlayback(session);
      }
      this.scheduleIdleDisconnect(guildId);
    });
  }

  clear(guildId: string): number {
    const state = this.getState(guildId);
    const cleared = state.queue.length;
    state.queue = [];
    return cleared;
  }

  shuffle(guildId: string): void {
    const state = this.getState(guildId);
    for (let i = state.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
  }

  remove(guildId: string, index: number): QueueItem | null {
    const state = this.getState(guildId);
    if (index < 0 || index >= state.queue.length) {
      return null;
    }
    const [removed] = state.queue.splice(index, 1);
    return removed ?? null;
  }

  insert(guildId: string, index: number, item: Omit<QueueItem, "id" | "addedAt">): QueueItem {
    const state = this.getState(guildId);
    const queueItem = this.materializeQueueItem(item);
    state.queue.splice(Math.max(0, index), 0, queueItem);
    this.songHistory?.recordTrack(queueItem);
    return queueItem;
  }

  mark(guildId: string, note: string): void {
    this.getState(guildId).incidentMarks.push({ at: Date.now(), note });
    this.recordDiagnostic(guildId, note);
  }

  describeNowPlaying(guildId: string): string {
    const state = this.getState(guildId);
    if (!state.current) {
      return "Nothing is playing right now.";
    }
    const elapsedSeconds = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    const details = state.current.resolverNote ? `\n${state.current.resolverNote}` : "";
    return `Now playing: **${state.current.title}** (${formatDuration(elapsedSeconds)} / ${formatDuration(state.current.durationSeconds)})${details}`;
  }

  queueSummary(guildId: string): string {
    const state = this.getState(guildId);
    if (!state.current && state.queue.length === 0) {
      return "Queue is empty.";
    }

    const lines: string[] = [];
    if (state.current) {
      lines.push(`Current: ${state.current.title}`);
      if (state.current.resolverNote) {
        lines.push(`   note: ${state.current.resolverNote}`);
      }
    }
    for (const [index, item] of state.queue.entries()) {
      lines.push(`${index + 1}. ${item.title}`);
      if (item.resolverNote) {
        lines.push(`   note: ${item.resolverNote}`);
      }
    }
    return lines.join("\n");
  }

  exportState(): MusicState[] {
    return [...this.states.values()].map((state) => ({ ...state, queue: [...state.queue] }));
  }

  getIdleDisconnectMs(): number {
    return this.idleDisconnectMs;
  }

  getDependencyReport(): string {
    return `${generateDependencyReport()}
Custom Voice Transport
- transport: davey websocket/udp transport
- prism-media: available
- opusscript: available
DAVE
- @snazzah/davey: ${DAVEY_VERSION}
- max protocol version: ${DAVE_PROTOCOL_VERSION}`;
  }

  getDiagnostics(guildId: string): string[] {
    return [...(this.diagnostics.get(guildId) ?? [])];
  }

  getRandomHistory(limit: number, userId?: string): SongHistoryRow[] {
    return this.songHistory?.getRandomSongs(limit, userId) ?? [];
  }

  private prefetchNext(guildId: string, resolver: MusicResolverService): void {
    const state = this.getState(guildId);
    const next = state.queue[0];
    if (!next || next.isResolved || next.prefetchedAt) {
      return;
    }

    void resolver.resolveQueueItem(next)
      .then((resolved) => {
        const current = state.queue[0];
        if (!current || current.id !== resolved.id) {
          return;
        }
        if (!resolved.streamUrl) {
          state.queue[0] = {
            ...current,
            resolverNote: resolved.resolverNote ?? current.resolverNote,
          };
          return;
        }
        state.queue[0] = {
          ...resolved,
          prefetchedAt: Date.now(),
        };
      })
      .catch(() => {
        // Prefetch failures should not break queue advancement.
      });
  }

  private materializeQueueItem(item: Omit<QueueItem, "id" | "addedAt">): QueueItem {
    return {
      ...item,
      id: crypto.randomUUID(),
      addedAt: Date.now(),
    };
  }

  private startCurrentTrack(guildId: string): void {
    const state = this.getState(guildId);
    const session = this.sessions.get(guildId);
    if (!state.current || !session) {
      state.playbackStatus = state.current ? "placeholder" : "idle";
      return;
    }

    const streamUrl = state.current.streamUrl;
    if (!streamUrl) {
      state.playbackStatus = "placeholder";
      return;
    }

    this.stopSessionPlayback(session);

    const ffmpeg = spawn(this.ffmpegPath, this.buildFfmpegArgs(state.current), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const playbackId = state.current.id;
    session.playbackId = playbackId;

    const stderrLines: string[] = [];
    ffmpeg.stderr.on("data", () => {
      // Keep stderr drained so ffmpeg does not block the process.
    });
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      stderrLines.push(...lines);
      while (stderrLines.length > 8) {
        stderrLines.shift();
      }
    });
    ffmpeg.on("error", () => {
      if (session.ffmpeg === ffmpeg && session.playbackId === playbackId) {
        void this.handleAutomaticPlaybackFailure(guildId, "ffmpeg process error");
      }
    });
    ffmpeg.on("close", (code) => {
      const wasActive = session.ffmpeg === ffmpeg && session.playbackId === playbackId;
      if (wasActive) {
        session.ffmpeg = null;
      }
      if (wasActive && code && code !== 0) {
        const stderrSummary = stderrLines.length > 0 ? ` | ffmpeg: ${stderrLines.join(" | ")}` : "";
        void this.handleAutomaticPlaybackFailure(guildId, `ffmpeg exited with code ${code}${stderrSummary}`);
      }
    });

    const encoder = new opus.OggDemuxer();

    encoder.on("error", () => {
      if (session.encoder === encoder && session.playbackId === playbackId) {
        void this.handleAutomaticPlaybackFailure(guildId, "Opus demuxer error");
      }
    });

    ffmpeg.stdout.pipe(encoder);
    session.ffmpeg = ffmpeg;
    session.encoder = encoder;
    session.transport.play(encoder, playbackId);
    state.playbackStatus = "playing";
    this.recordDiagnostic(guildId, `Started DAVE playback for ${state.current.title}.`);
  }

  private buildFfmpegArgs(track: QueueItem): string[] {
    const inputArgs = [
      "-nostdin",
      "-loglevel", "warning",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-thread_queue_size", "4096",
      "-analyzeduration", "0",
      "-probesize", "32k",
      "-fflags", "+nobuffer",
    ];

    const headers = track.streamHeaders ?? {};
    const userAgent = headers["User-Agent"] ?? headers["user-agent"];
    if (userAgent) {
      inputArgs.push("-user_agent", userAgent);
    }

    const headerLines = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== "user-agent")
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
    if (headerLines) {
      inputArgs.push("-headers", `${headerLines}\r\n`);
    }

    inputArgs.push("-i", track.streamUrl ?? track.url);

    return [
      ...inputArgs,
      "-vn",
      "-ar", "48000",
      "-ac", "2",
      "-c:a", "libopus",
      "-b:a", "128k",
      "-vbr", "on",
      "-frame_duration", "20",
      "-application", "audio",
      "-f", "opus",
      "pipe:1",
    ];
  }

  private scheduleIdleDisconnect(guildId: string): void {
    const state = this.getState(guildId);
    const session = this.sessions.get(guildId);
    if (!state.shouldLeave || !session || state.current || state.queue.length > 0) {
      return;
    }
    if (session.idleTimer) {
      return;
    }
    state.connectionStatus = "idle-disconnect-pending";
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      const latest = this.getState(guildId);
      if (latest.current || latest.queue.length > 0 || !latest.shouldLeave) {
        latest.connectionStatus = this.sessions.has(guildId) ? "connected" : "disconnected";
        return;
      }
      this.disconnect(guildId, "idle-timeout");
    }, this.idleDisconnectMs);
  }

  private cancelIdleDisconnect(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session?.idleTimer) {
      return;
    }
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
    const state = this.getState(guildId);
    state.connectionStatus = "connected";
  }

  private stopSessionPlayback(session: GuildVoiceSession): void {
    session.playbackId = null;
    const legacyPlayer = Reflect.get(session as object, "player") as { stop?: (force?: boolean) => void } | undefined;
    if (session.ffmpeg && !session.ffmpeg.killed) {
      session.ffmpeg.kill();
      session.ffmpeg = null;
    }
    if (session.encoder && "destroy" in session.encoder) {
      session.encoder.destroy();
      session.encoder = null;
    }
    session.transport?.stop();
    legacyPlayer?.stop?.(true);
  }

  private clearSession(guildId: string, destroyConnection = false): void {
    const session = this.sessions.get(guildId);
    if (!session) {
      return;
    }

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    this.stopSessionPlayback(session);
    this.sessions.delete(guildId);

    if (destroyConnection) {
      const legacyConnection = Reflect.get(session as object, "connection") as { destroy?: () => void } | undefined;
      this.recordDiagnostic(guildId, "Destroying voice connection.");
      session.transport?.disconnect();
      legacyConnection?.destroy?.();
    }
  }

  private recordDiagnostic(guildId: string, message: string): void {
    const lines = this.diagnostics.get(guildId) ?? [];
    const line = `[${new Date().toISOString()}] ${message}`;
    lines.push(line);
    while (lines.length > 30) {
      lines.shift();
    }
    this.diagnostics.set(guildId, lines);
    this.diagnosticMirror?.(guildId, line);
  }

  private getResolver(resolver?: MusicResolverService): MusicResolverService | undefined {
    return resolver ?? this.resolver ?? undefined;
  }

  private async runGuildOperation<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChains.get(guildId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operationChains.set(guildId, next);
    try {
      return await next;
    } finally {
      if (this.operationChains.get(guildId) === next) {
        this.operationChains.delete(guildId);
      }
    }
  }

  private async advancePlaybackInternal(
    guildId: string,
    resolver?: MusicResolverService,
  ): Promise<QueueItem | null> {
    const state = this.getState(guildId);
    let next: QueueItem | null = null;
    while (state.queue.length > 0 && !next) {
      const candidate = state.queue.shift() ?? null;
      if (!candidate) {
        break;
      }
      const resolved = resolver ? await resolver.resolveQueueItem(candidate) : candidate;
      if (!resolved.streamUrl) {
        this.mark(guildId, `Skipped unplayable queue item: ${resolved.title}`);
        continue;
      }
      next = resolved;
    }
    state.current = next;
    state.startedAt = next ? Date.now() : null;
    state.isPaused = false;
    state.playbackStatus = next ? "placeholder" : "idle";
    if (resolver) {
      this.prefetchNext(guildId, resolver);
    }
    if (!next) {
      this.scheduleIdleDisconnect(guildId);
      return null;
    }
    this.cancelIdleDisconnect(guildId);
    this.startCurrentTrack(guildId);
    return next;
  }

  private async skipInternal(
    guildId: string,
    reason: string,
    resolver?: MusicResolverService,
  ): Promise<QueueItem | null> {
    const state = this.getState(guildId);
    state.lastStopReason = reason;
    state.current = null;
    state.startedAt = null;
    state.isPaused = false;
    state.playbackStatus = "idle";
    const session = this.sessions.get(guildId);
    if (session) {
      this.stopSessionPlayback(session);
    }
    return this.advancePlaybackInternal(guildId, resolver);
  }

  private async handlePlaybackFailureInternal(
    guildId: string,
    reason: string,
    resolver?: MusicResolverService,
  ): Promise<QueueItem | null> {
    const state = this.getState(guildId);
    const session = this.sessions.get(guildId);
    if (session) {
      this.stopSessionPlayback(session);
    }
    this.mark(guildId, `Playback failure: ${reason}`);
    state.current = null;
    state.startedAt = null;
    state.isPaused = false;
    state.playbackStatus = "idle";
    state.lastStopReason = "playback-failed";
    return this.advancePlaybackInternal(guildId, resolver);
  }

  private async handleTransportPlaybackFinished(guildId: string, playbackId: string): Promise<void> {
    let nextTrack: QueueItem | null = null;
    await this.runGuildOperation(guildId, async () => {
      const session = this.sessions.get(guildId);
      if (!session || session.playbackId !== playbackId) {
        return;
      }
      session.playbackId = null;

      const currentState = this.getState(guildId);
      if (!currentState.current || currentState.playbackStatus === "placeholder") {
        currentState.playbackStatus = currentState.current ? "placeholder" : "idle";
        return;
      }

      currentState.current = null;
      currentState.startedAt = null;
      currentState.isPaused = false;
      currentState.playbackStatus = "idle";
      nextTrack = await this.advancePlaybackInternal(guildId, this.getResolver());
    });

    if (this.onTrackFinished) {
      await this.onTrackFinished(guildId, nextTrack);
    }
  }

  private async handleTransportPlaybackError(
    guildId: string,
    playbackId: string,
    reason: string,
  ): Promise<void> {
    let nextTrack: QueueItem | null = null;
    await this.runGuildOperation(guildId, async () => {
      const session = this.sessions.get(guildId);
      if (!session || session.playbackId !== playbackId) {
        return;
      }
      nextTrack = await this.handlePlaybackFailureInternal(guildId, reason, this.getResolver());
    });

    if (this.onTrackFinished) {
      await this.onTrackFinished(guildId, nextTrack);
    }
  }

  private async handleAutomaticPlaybackFailure(
    guildId: string,
    reason: string,
  ): Promise<void> {
    const nextTrack = await this.handlePlaybackFailure(guildId, reason, this.getResolver());
    if (this.onTrackFinished) {
      await this.onTrackFinished(guildId, nextTrack);
    }
  }
}
