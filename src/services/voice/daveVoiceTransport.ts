import crypto from "node:crypto";
import dgram, { type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterImplementerMethods,
  type DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import type { APIVoiceState, GatewayVoiceServerUpdateDispatchData } from "discord-api-types/v10";
import type { GuildMember } from "discord.js";
import WebSocket from "ws";
import { DaveSessionManager } from "./daveSessionManager.js";
import {
  VoiceOpcode,
  type DaveGatewayAction,
  type DavePrepareEpochPayload,
  type DavePrepareTransitionPayload,
  type DaveExecuteTransitionPayload,
} from "./daveProtocol.js";
import type {
  VoiceConnectionState,
  VoicePlaybackState,
  VoiceTransport,
  VoiceTransportCallbacks,
} from "./voiceTransport.js";

const KEEP_ALIVE_INTERVAL_MS = 5_000;
const HEARTBEAT_MISSES_BEFORE_CLOSE = 3;
const RTP_TIMESTAMP_INCREMENT = 960;
const RTP_FRAME_DURATION_MS = 20;
const SILENCE_FRAME = Buffer.from([248, 255, 254]);
const PREBUFFER_FRAMES = 16;
const MAX_BUFFERED_FRAMES = 128;
const RESUME_BUFFERED_FRAMES = 48;
const SCHEDULER_RESYNC_THRESHOLD_MS = 35;
const TIMING_SUMMARY_INTERVAL_PACKETS = 100;
const SCHEDULER_COARSE_SLEEP_MS = 16;
const SCHEDULER_EARLY_TOLERANCE_MS = 0.75;
const MAX_DROPPED_FRAMES_PER_TICK = 4;

type SupportedEncryptionMode =
  | "aead_aes256_gcm_rtpsize"
  | "aead_xchacha20_poly1305_rtpsize";

enum VoiceGatewayOpcode {
  Identify = 0,
  SelectProtocol = 1,
  Ready = 2,
  Heartbeat = 3,
  SessionDescription = 4,
  Speaking = 5,
  HeartbeatAck = 6,
  Resume = 7,
  Hello = 8,
  Resumed = 9,
}

interface VoiceGatewayPacket {
  op: number;
  d: Record<string, unknown>;
  seq?: number;
}

interface VoiceReadyPayload {
  ip: string;
  port: number;
  ssrc: number;
  modes: string[];
}

interface VoiceSessionDescriptionPayload {
  mode: SupportedEncryptionMode;
  secret_key: number[];
  dave_protocol_version?: number;
}

interface PlaybackSession {
  readonly source: Readable;
  readonly playbackId: string | null;
  readonly queue: Buffer[];
  ended: boolean;
  paused: boolean;
  buffering: boolean;
  silenceFramesRemaining: number;
  ticker: Worker | null;
  timer: NodeJS.Timeout | NodeJS.Immediate | null;
  timerKind: "timeout" | "immediate" | null;
  nextDispatchAt: number;
  daveWaitLogged: boolean;
  underrunLogged: boolean;
  tickerTerminationExpected: boolean;
  readonly onData: (chunk: unknown) => void;
  readonly onEnd: () => void;
  readonly onError: (error: Error) => void;
}

interface TimingStats {
  packets: number;
  anomalies: number;
  lastSendAt: number | null;
  deltaSumMs: number;
  deltaMinMs: number;
  deltaMaxMs: number;
  lateSumMs: number;
  lateMaxMs: number;
  queueMin: number;
  queueMax: number;
}

interface PlaybackTickerMessage {
  type: "tick";
  scheduledAt: number;
}

export interface PlaybackDispatchPlan {
  shouldSendFrame: boolean;
  framesToDrop: number;
  lateByMs: number;
  nextDispatchAt: number;
  resynchronized: boolean;
}

export function planPlaybackDispatch(now: number, scheduledAt: number): PlaybackDispatchPlan {
  const lateByMs = now - scheduledAt;
  if (lateByMs < -SCHEDULER_EARLY_TOLERANCE_MS) {
    return {
      shouldSendFrame: false,
      framesToDrop: 0,
      lateByMs,
      nextDispatchAt: scheduledAt,
      resynchronized: false,
    };
  }

  const framesToDrop = Math.min(
    MAX_DROPPED_FRAMES_PER_TICK,
    Math.max(0, Math.floor(lateByMs / RTP_FRAME_DURATION_MS)),
  );
  const resynchronized = framesToDrop > 0 || lateByMs > SCHEDULER_RESYNC_THRESHOLD_MS;
  return {
    shouldSendFrame: true,
    framesToDrop,
    lateByMs,
    nextDispatchAt: resynchronized ? now + RTP_FRAME_DURATION_MS : scheduledAt + RTP_FRAME_DURATION_MS,
    resynchronized,
  };
}

function randomNBit(bits: number): number {
  return Math.floor(Math.random() * 2 ** bits);
}

function parseLocalPacket(message: Buffer): { ip: string; port: number } {
  const ip = message.subarray(8, message.indexOf(0, 8)).toString("utf8");
  if (!isIPv4(ip)) {
    throw new Error("Malformed IP discovery response.");
  }

  return {
    ip,
    port: message.readUInt16BE(message.length - 2),
  };
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data as object)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return Buffer.from(String(data));
}

export class DaveVoiceTransport implements VoiceTransport {
  readonly guildId: string;
  readonly channelId: string;

  private readonly userId: string;
  private readonly daveSession: DaveSessionManager;

  private adapter: DiscordGatewayAdapterImplementerMethods | null = null;
  private ws: WebSocket | null = null;
  private udp: Socket | null = null;
  private playback: PlaybackSession | null = null;

  private connectPromise: Promise<void> | null = null;
  private connectResolver: (() => void) | null = null;
  private connectRejecter: ((error: Error) => void) | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;

  private serverUpdate: GatewayVoiceServerUpdateDispatchData | null = null;
  private sessionId: string | null = null;
  private endpoint: string | null = null;
  private udpRemoteIp: string | null = null;
  private udpRemotePort: number | null = null;

  private connectionState: VoiceConnectionState = "disconnected";
  private playbackState: VoicePlaybackState = "idle";
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private udpKeepAliveInterval: NodeJS.Timeout | null = null;
  private udpKeepAliveCounter = 0;
  private missedHeartbeats = 0;
  private lastHeartbeatSentAt = 0;
  private wsPingMs = -1;
  private destroyed = false;

  private secretKey: Uint8Array | null = null;
  private encryptionMode: SupportedEncryptionMode | null = null;
  private nonce = 0;
  private nonceBuffer = Buffer.alloc(24);
  private sequence = randomNBit(16);
  private timestamp = randomNBit(32);
  private ssrc = 0;
  private speaking = false;
  private lastGatewaySequence = -1;
  private timingStats: TimingStats = this.createTimingStats();

  constructor(
    private readonly member: GuildMember,
    private readonly callbacks: VoiceTransportCallbacks = {},
  ) {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error("Join a voice channel first.");
    }

    this.guildId = member.guild.id;
    this.channelId = voiceChannel.id;
    this.userId = member.client.user?.id ?? member.guild.members.me?.id ?? "";
    this.daveSession = new DaveSessionManager(this.userId, this.channelId);
    this.daveSession.setRecognizedUserIds([...voiceChannel.members.keys(), this.userId].filter(Boolean));
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.isConnected()) {
      return;
    }

    this.destroyed = false;
    this.setConnectionState("connecting");
    this.log("Opening DAVE voice transport.");

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolver = resolve;
      this.connectRejecter = reject;
    });

    this.connectTimeout = setTimeout(() => {
      this.rejectConnect(new Error("Timed out while establishing the voice connection."));
    }, 20_000);
    this.connectTimeout.unref();

    try {
      this.createGatewayAdapter();
      this.sendGatewayJoinPayload(this.channelId);
    } catch (error) {
      this.rejectConnect(error instanceof Error ? error : new Error(String(error)));
    }

    return this.connectPromise;
  }

  disconnect(): void {
    this.destroyed = true;
    this.stop();
    this.setSpeaking(false);
    this.cleanupNetwork();

    if (this.adapter) {
      try {
        this.adapter.sendPayload({
          op: 4,
          d: {
            guild_id: this.guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: true,
          },
        });
      } catch {
        // Best effort leave payload.
      }

      try {
        this.adapter.destroy();
      } catch {
        // Ignore adapter teardown failures.
      }
      this.adapter = null;
    }

    this.clearConnectTimeout();
    this.connectPromise = null;
    this.connectResolver = null;
    this.connectRejecter = null;
    this.setConnectionState("disconnected");
  }

  play(stream: Readable, playbackId: string | null = null): void {
    this.stop();

    const onData = (chunk: unknown) => {
      if (!this.playback) {
        return;
      }
      const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      this.playback.queue.push(frame);
      if (this.playback.queue.length >= MAX_BUFFERED_FRAMES) {
        this.playback.source.pause();
      }
    };

    const onEnd = () => {
      if (this.playback) {
        this.playback.ended = true;
      }
    };

    const onError = (error: Error) => {
      this.log(`Playback stream error: ${error.message}`);
      this.callbacks.onPlaybackError?.(error, playbackId);
    };

    this.playback = {
      source: stream,
      playbackId,
      queue: [],
      ended: false,
      paused: false,
      buffering: true,
      silenceFramesRemaining: 5,
      ticker: null,
      timer: null,
      timerKind: null,
      nextDispatchAt: performance.now() + RTP_FRAME_DURATION_MS,
      daveWaitLogged: false,
      underrunLogged: false,
      tickerTerminationExpected: false,
      onData,
      onEnd,
      onError,
    };
    this.timingStats = this.createTimingStats();

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);

    if (!this.isPlaybackReady()) {
      stream.pause();
      this.playback.daveWaitLogged = true;
      this.log("Waiting for the DAVE session to become ready before streaming audio.");
    } else {
      stream.resume();
    }

    this.setPlaybackState("playing");
    this.startPlaybackScheduler();
  }

  pause(): boolean {
    if (!this.playback || this.playback.paused) {
      return false;
    }

    this.playback.paused = true;
    this.clearPlaybackTimer(this.playback);
    this.playback.source.pause();
    this.setSpeaking(false);
    this.setPlaybackState("paused");
    return true;
  }

  resume(): boolean {
    if (!this.playback || !this.playback.paused) {
      return false;
    }

    this.playback.paused = false;
    if (this.isPlaybackReady()) {
      this.playback.source.resume();
    }
    this.setPlaybackState("playing");
    this.startPlaybackScheduler();
    return true;
  }

  stop(): void {
    if (!this.playback) {
      this.setPlaybackState("idle");
      return;
    }

    this.clearPlaybackTimer(this.playback);
    this.playback.source.off("data", this.playback.onData);
    this.playback.source.off("end", this.playback.onEnd);
    this.playback.source.off("error", this.playback.onError);
    this.playback = null;
    this.setSpeaking(false);
    this.setPlaybackState("idle");
  }

  isConnected(): boolean {
    return this.connectionState === "connected" && this.ws !== null && this.udp !== null;
  }

  getDebugState(): string {
    const daveMode = this.daveSession.currentProtocolVersion > 0
      ? `DAVE v${this.daveSession.currentProtocolVersion}${this.daveSession.ready ? ` (${this.daveSession.currentVoicePrivacyCode || "ready"})` : " (pending)"}`
      : "transport-only";
    return `Voice channel: <#${this.channelId}> | connection: ${this.connectionState} | playback: ${this.playbackState} | ws ping: ${this.wsPingMs}ms | mode: ${daveMode}`;
  }

  private createGatewayAdapter(): void {
    const baseAdapterCreator = this.member.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator;
    const methods: DiscordGatewayAdapterLibraryMethods = {
      destroy: () => {
        this.log("Gateway adapter destroy callback invoked.");
        this.disconnect();
      },
      onVoiceServerUpdate: (data) => {
        this.serverUpdate = data;
        this.endpoint = data.endpoint;
        this.log(`Received VOICE_SERVER_UPDATE endpoint=${data.endpoint ?? "null"} guild=${data.guild_id}.`);
        this.maybeOpenWebSocket();
      },
      onVoiceStateUpdate: (data) => {
        const state = data as APIVoiceState;
        this.sessionId = state.session_id;
        this.log(`Received VOICE_STATE_UPDATE channel=${state.channel_id ?? "null"} session=${state.session_id ?? "unknown"}.`);
        if (state.channel_id === null && !this.destroyed) {
          this.log("Discord reported that the bot left the voice channel.");
          this.disconnect();
          return;
        }
        this.maybeOpenWebSocket();
      },
    };

    const adapter = baseAdapterCreator(methods);
    this.adapter = {
      sendPayload: (payload) => {
        const sent = adapter.sendPayload(payload);
        this.log(
          `Adapter sendPayload op=${payload.op ?? "unknown"} guild=${payload.d?.guild_id ?? this.guildId} channel=${payload.d?.channel_id ?? "null"} result=${sent}.`,
        );
        return sent;
      },
      destroy: () => {
        this.log("Adapter destroy called by transport.");
        adapter.destroy();
      },
    };
  }

  private sendGatewayJoinPayload(channelId: string): void {
    if (!this.adapter) {
      throw new Error("Voice adapter was not initialized.");
    }

    const sent = this.adapter.sendPayload({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: channelId,
        self_mute: false,
        self_deaf: true,
      },
    });

    if (!sent) {
      throw new Error("Could not send the Discord voice join payload.");
    }
  }

  private maybeOpenWebSocket(): void {
    if (this.ws || !this.sessionId || !this.serverUpdate?.token || !this.serverUpdate.endpoint) {
      return;
    }

    this.endpoint = this.serverUpdate.endpoint;
    const address = `wss://${this.serverUpdate.endpoint}?v=8&encoding=json`;
    this.log(`Opening voice WebSocket ${address}.`);
    this.ws = new WebSocket(address);
    this.ws.on("open", () => {
      this.log("Voice WebSocket opened.");
      this.sendJson(VoiceGatewayOpcode.Identify, {
        server_id: this.guildId,
        user_id: this.userId,
        session_id: this.sessionId,
        token: this.serverUpdate?.token,
        ...this.daveSession.getIdentifyData(),
      });
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleBinaryGatewayMessage(toBuffer(data));
      } else {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        this.handleJsonGatewayMessage(text);
      }
    });
    this.ws.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Voice WebSocket error: ${err.message}`);
      this.callbacks.onPlaybackError?.(err, null);
      this.rejectConnect(err);
    });
    this.ws.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer.toString("utf8");
      this.log(`Voice WebSocket close event code=${code} reason=${reason || "none"}.`);
      if (!this.destroyed) {
        this.rejectConnect(new Error(`Voice WebSocket closed with code ${code}${reason ? ` (${reason})` : ""}.`));
        this.disconnect();
      }
    });
  }

  private handleJsonGatewayMessage(raw: string): void {
    this.log(`[voice] [WS] << ${raw}`);

    let packet: VoiceGatewayPacket;
    try {
      packet = JSON.parse(raw) as VoiceGatewayPacket;
    } catch (error) {
      this.log(`Failed to parse voice WebSocket JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (typeof packet.seq === "number") {
      this.lastGatewaySequence = packet.seq;
    }

    switch (packet.op) {
      case VoiceGatewayOpcode.Hello:
        this.startHeartbeat(Number(packet.d.heartbeat_interval ?? 0));
        return;
      case VoiceGatewayOpcode.HeartbeatAck:
        this.missedHeartbeats = 0;
        this.wsPingMs = Date.now() - Number(
          typeof packet.d === "object" && packet.d !== null && "t" in packet.d
            ? (packet.d as { t?: number }).t ?? this.lastHeartbeatSentAt
            : this.lastHeartbeatSentAt,
        );
        return;
      case VoiceGatewayOpcode.Ready:
        this.handleReadyPacket(packet.d as unknown as VoiceReadyPayload);
        return;
      case VoiceGatewayOpcode.SessionDescription:
        this.handleSessionDescription(packet.d as unknown as VoiceSessionDescriptionPayload);
        return;
      case VoiceGatewayOpcode.Resumed:
        this.log("Voice WebSocket resumed.");
        return;
      case VoiceOpcode.CLIENTS_CONNECT:
        if (typeof packet.d.user_id === "string") {
          this.daveSession.addRecognizedUsers([packet.d.user_id]);
        }
        return;
      case VoiceOpcode.CLIENT_DISCONNECT:
        if (typeof packet.d.user_id === "string") {
          this.daveSession.removeRecognizedUsers([packet.d.user_id]);
        }
        return;
      case VoiceOpcode.DAVE_PREPARE_TRANSITION:
        this.handleDaveTransitionJson(this.daveSession.handlePrepareTransition(packet.d as unknown as DavePrepareTransitionPayload));
        return;
      case VoiceOpcode.DAVE_EXECUTE_TRANSITION:
        this.handleDaveTransitionJson(this.daveSession.handleExecuteTransition(packet.d as unknown as DaveExecuteTransitionPayload));
        return;
      case VoiceOpcode.DAVE_PREPARE_EPOCH:
        this.handleDaveTransitionJson(this.daveSession.handlePrepareEpoch(packet.d as unknown as DavePrepareEpochPayload));
        return;
      default:
        return;
    }
  }

  private handleReadyPacket(payload: VoiceReadyPayload): void {
    this.ssrc = payload.ssrc;
    this.udpRemoteIp = payload.ip;
    this.udpRemotePort = payload.port;
    this.log(`Voice ready received ip=${payload.ip} port=${payload.port} ssrc=${payload.ssrc}.`);

    this.udp = dgram.createSocket("udp4");
    this.udp.on("message", (message) => {
      this.handleUdpMessage(message);
    });
    this.udp.on("error", (error) => {
      this.log(`Voice UDP error: ${error.message}`);
      this.callbacks.onPlaybackError?.(error, null);
    });
    this.udp.on("close", () => {
      this.log("Voice UDP socket closed.");
      if (!this.destroyed) {
        this.disconnect();
      }
    });

    void this.performIpDiscovery(payload.ip, payload.port, payload.ssrc)
      .then((localConfig) => {
        const mode = this.chooseEncryptionMode(payload.modes);
        this.sendJson(VoiceGatewayOpcode.SelectProtocol, {
          protocol: "udp",
          data: {
            address: localConfig.ip,
            port: localConfig.port,
            mode,
          },
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.rejectConnect(err);
      });
  }

  private handleSessionDescription(payload: VoiceSessionDescriptionPayload): void {
    this.encryptionMode = payload.mode;
    this.secretKey = new Uint8Array(payload.secret_key);
    this.nonce = 0;
    this.nonceBuffer = payload.mode === "aead_aes256_gcm_rtpsize" ? Buffer.alloc(12) : Buffer.alloc(24);
    this.sequence = randomNBit(16);
    this.timestamp = randomNBit(32);

    this.log(`Voice session description received with mode=${payload.mode} dave=${payload.dave_protocol_version ?? 0}.`);
    this.handleDaveTransitionJson(this.daveSession.handleSessionDescription(payload.dave_protocol_version ?? 0));

    this.startUdpKeepAlive();
    this.setConnectionState("connected");
    this.resolveConnect();
  }

  private handleDaveTransitionJson(actions: DaveGatewayAction[]): void {
    const wasReady = this.isPlaybackReady();
    this.applyDaveActions(actions);
    this.handlePlaybackReadinessChange(wasReady);
  }

  private handleBinaryGatewayMessage(message: Buffer): void {
    if (message.length < 3) {
      return;
    }

    this.lastGatewaySequence = message.readUInt16BE(0);
    this.log(`[voice] [WS] << binary seq=${this.lastGatewaySequence} op=${message.readUInt8(2)} bytes=${message.length}`);

    const wasReady = this.isPlaybackReady();
    this.applyDaveActions(this.daveSession.handleBinaryMessage(message));
    this.handlePlaybackReadinessChange(wasReady);
  }

  private applyDaveActions(actions: DaveGatewayAction[]): void {
    for (const action of actions) {
      if (action.kind === "log") {
        this.log(`[DAVE] ${action.message}`);
      } else if (action.kind === "send-json") {
        this.sendJson(action.op, action.data);
      } else if (action.kind === "send-binary") {
        this.sendBinary(action.op, action.body);
      }
    }
  }

  private handlePlaybackReadinessChange(previouslyReady: boolean): void {
    const ready = this.isPlaybackReady();
    if (!previouslyReady && ready && this.playback && !this.playback.paused) {
      this.log(`DAVE session is ready for playback (${this.daveSession.currentVoicePrivacyCode || "no privacy code"}).`);
      this.playback.source.resume();
    } else if (previouslyReady && !ready && this.playback) {
      this.log("Playback paused while the DAVE session transitions.");
      this.playback.source.pause();
    }
  }

  private async performIpDiscovery(remoteIp: string, remotePort: number, ssrc: number): Promise<{ ip: string; port: number }> {
    if (!this.udp) {
      throw new Error("UDP socket was not created before IP discovery.");
    }

    return new Promise((resolve, reject) => {
      const socket = this.udp!;
      const cleanup = () => {
        socket.off("message", onMessage);
        socket.off("close", onClose);
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Cannot perform IP discovery because the UDP socket closed."));
      };

      const onMessage = (message: Buffer) => {
        try {
          if (message.readUInt16BE(0) !== 2) {
            return;
          }
          cleanup();
          resolve(parseLocalPacket(message));
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      socket.on("message", onMessage);
      socket.once("close", onClose);

      const discoveryBuffer = Buffer.alloc(74);
      discoveryBuffer.writeUInt16BE(1, 0);
      discoveryBuffer.writeUInt16BE(70, 2);
      discoveryBuffer.writeUInt32BE(ssrc, 4);
      socket.send(discoveryBuffer, remotePort, remoteIp, (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      });
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (intervalMs <= 0) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.lastHeartbeatSentAt !== 0 && this.missedHeartbeats >= HEARTBEAT_MISSES_BEFORE_CLOSE) {
        this.log("Voice WebSocket heartbeat timed out.");
        this.ws?.close();
        return;
      }

      this.lastHeartbeatSentAt = Date.now();
      this.missedHeartbeats += 1;
      this.sendJson(VoiceGatewayOpcode.Heartbeat, {
        t: this.lastHeartbeatSentAt,
        seq_ack: this.lastGatewaySequence,
      });
    }, intervalMs);
    this.heartbeatInterval.unref();
  }

  private startUdpKeepAlive(): void {
    if (!this.udp) {
      return;
    }

    if (this.udpKeepAliveInterval) {
      clearInterval(this.udpKeepAliveInterval);
    }

    this.udpKeepAliveInterval = setInterval(() => {
      if (!this.udp) {
        return;
      }
      const keepAlive = Buffer.alloc(8);
      keepAlive.writeUInt32LE(this.udpKeepAliveCounter, 0);
      this.udpKeepAliveCounter = (this.udpKeepAliveCounter + 1) >>> 0;
      this.sendUdpPacket(keepAlive);
    }, KEEP_ALIVE_INTERVAL_MS);
    this.udpKeepAliveInterval.unref();
  }

  private handleUdpMessage(_message: Buffer): void {
    // Music playback is send-only for now; UDP receive is only needed for discovery and keepalive.
  }

  private flushPlayback(): boolean {
    if (!this.playback || !this.secretKey || !this.encryptionMode || !this.udp) {
      return false;
    }

    if (this.playback.paused) {
      return false;
    }

    if (!this.isPlaybackReady()) {
      if (!this.playback.daveWaitLogged) {
        this.playback.source.pause();
        this.playback.daveWaitLogged = true;
        this.log("Waiting for DAVE readiness before sending queued audio.");
      }
      this.setSpeaking(false);
      return false;
    }

    if (this.playback.queue.length <= RESUME_BUFFERED_FRAMES && !this.playback.ended) {
      this.playback.source.resume();
    }

    if (this.playback.buffering) {
      if (!this.playback.ended && this.playback.queue.length < PREBUFFER_FRAMES) {
        return false;
      }
      this.playback.buffering = false;
      this.playback.underrunLogged = false;
      this.log(`Playback buffer primed with ${this.playback.queue.length} Opus frame(s).`);
    }

    let frame: Buffer | null = null;
    if (this.playback.queue.length > 0) {
      frame = this.playback.queue.shift() ?? null;
    } else if (this.playback.ended && this.playback.silenceFramesRemaining > 0) {
      this.playback.silenceFramesRemaining -= 1;
      frame = SILENCE_FRAME;
    } else if (this.playback.ended) {
      this.finishPlayback();
      return false;
    }

    if (!frame) {
      this.playback.buffering = true;
      if (!this.playback.underrunLogged) {
        this.playback.underrunLogged = true;
        this.log("Playback buffer underrun detected; rebuffering before sending more audio.");
      }
      this.setSpeaking(false);
      return false;
    }

    this.playback.underrunLogged = false;
    this.sendOpusFrame(frame);
    return true;
  }

  private dropPlaybackFrames(count: number): number {
    if (!this.playback || count <= 0) {
      return 0;
    }

    let dropped = 0;
    while (dropped < count && this.playback.queue.length > 0) {
      this.playback.queue.shift();
      dropped += 1;
    }
    return dropped;
  }

  private startPlaybackScheduler(): void {
    if (!this.playback || this.playback.paused) {
      return;
    }

    this.clearPlaybackTimer(this.playback);
    this.playback.nextDispatchAt = performance.now() + RTP_FRAME_DURATION_MS;

    try {
      this.playback.ticker = this.createPlaybackTicker();
      this.schedulePlaybackWorkerTick(this.playback.nextDispatchAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Falling back to the main-thread playback timer: ${message}`);
      this.playback.ticker = null;
      this.schedulePlaybackTick();
    }
  }

  private createPlaybackTicker(): Worker {
    const worker = new Worker(new URL("./playbackTickerWorker.js", import.meta.url));

    worker.on("message", (message: unknown) => {
      if (!this.playback || this.playback.ticker !== worker) {
        return;
      }

      if (!this.isPlaybackTickerMessage(message)) {
        return;
      }

      this.handlePlaybackTick(message.scheduledAt);
    });

    worker.on("error", (error) => {
      this.log(`Playback ticker worker error: ${error.message}`);
      if (!this.playback || this.playback.ticker !== worker) {
        return;
      }
      this.playback.ticker = null;
      if (!this.playback.paused) {
        this.schedulePlaybackTick();
      }
    });

    worker.on("exit", (code) => {
      if (code !== 0 && !this.playback?.tickerTerminationExpected) {
        this.log(`Playback ticker worker exited with code ${code}.`);
      }
      if (!this.playback || this.playback.ticker !== worker) {
        return;
      }
      this.playback.ticker = null;
      if (!this.playback.paused) {
        this.schedulePlaybackTick();
      }
    });

    worker.unref();
    return worker;
  }

  private isPlaybackTickerMessage(message: unknown): message is PlaybackTickerMessage {
    if (!message || typeof message !== "object") {
      return false;
    }

    const candidate = message as Partial<PlaybackTickerMessage>;
    return candidate.type === "tick" && typeof candidate.scheduledAt === "number";
  }

  private schedulePlaybackWorkerTick(scheduledAt: number): void {
    if (!this.playback?.ticker) {
      return;
    }

    this.playback.ticker.postMessage({
      type: "schedule",
      scheduledAt,
    });
  }

  private handlePlaybackTick(scheduledAt: number): void {
    if (!this.playback) {
      return;
    }

    const now = performance.now();
    const plan = planPlaybackDispatch(now, scheduledAt);
    if (plan.shouldSendFrame) {
      const droppedFrames = this.dropPlaybackFrames(plan.framesToDrop);
      const sent = this.flushPlayback();

      if (!this.playback) {
        return;
      }

      if (sent) {
        this.recordTimingSample(performance.now(), this.playback.queue.length, scheduledAt);
        if (plan.resynchronized) {
          this.log(
            `Playback scheduler drift exceeded ${SCHEDULER_RESYNC_THRESHOLD_MS}ms; dropped ${droppedFrames} overdue frame(s) and resynchronized.`,
          );
          this.logTiming(
            `scheduler_resync late=${plan.lateByMs.toFixed(2)}ms queue=${this.playback.queue.length} dropped=${droppedFrames}`,
          );
        } else if (droppedFrames > 0) {
          this.logTiming(
            `scheduler_drop late=${plan.lateByMs.toFixed(2)}ms queue=${this.playback.queue.length} dropped=${droppedFrames}`,
          );
        }
      }
    }

    if (!this.playback) {
      return;
    }

    this.playback.nextDispatchAt = plan.shouldSendFrame ? plan.nextDispatchAt : scheduledAt;
    if (this.playback.ticker) {
      this.schedulePlaybackWorkerTick(this.playback.nextDispatchAt);
      return;
    }

    if (!plan.shouldSendFrame) {
      this.schedulePlaybackTick();
      return;
    }

    if (!this.playback.paused) {
      if (!this.playback.queue.length && !this.playback.ended) {
        this.playback.nextDispatchAt = performance.now() + RTP_FRAME_DURATION_MS;
      }
      this.schedulePlaybackTick();
    }
  }

  private schedulePlaybackTick(): void {
    if (!this.playback || this.playback.ticker) {
      return;
    }

    const remainingMs = this.playback.nextDispatchAt - performance.now();
    const runTick = () => {
      if (!this.playback || this.playback.ticker) {
        return;
      }
      this.handlePlaybackTick(this.playback.nextDispatchAt);
    };

    if (remainingMs > SCHEDULER_COARSE_SLEEP_MS) {
      this.playback.timer = setTimeout(runTick, Math.max(1, remainingMs - SCHEDULER_COARSE_SLEEP_MS));
      this.playback.timerKind = "timeout";
      this.playback.timer.unref();
      return;
    }

    const immediate = setImmediate(runTick);
    this.playback.timer = immediate;
    this.playback.timerKind = "immediate";
    immediate.unref();
  }

  private sendOpusFrame(opusFrame: Buffer): void {
    if (!this.udp || !this.secretKey || !this.encryptionMode) {
      return;
    }

    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 0x78;
    header.writeUInt16BE(this.sequence, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc, 8);

    const daveFrame = this.daveSession.ready && !opusFrame.equals(SILENCE_FRAME)
      ? this.daveSession.encryptOpus(opusFrame)
      : opusFrame;
    const encrypted = this.encryptTransportPacket(daveFrame, header);
    const packet = Buffer.concat([header, encrypted.cipherText, encrypted.noncePadding]);

    this.sendUdpPacket(packet);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + RTP_TIMESTAMP_INCREMENT) >>> 0;
    this.setSpeaking(true);
  }

  private encryptTransportPacket(opusFrame: Buffer, header: Buffer): { cipherText: Buffer; noncePadding: Buffer } {
    if (!this.secretKey || !this.encryptionMode) {
      throw new Error("Transport encryption is not ready.");
    }

    this.nonce = (this.nonce + 1) >>> 0;
    this.nonceBuffer.writeUInt32BE(this.nonce, 0);
    const noncePadding = this.nonceBuffer.subarray(0, 4);

    if (this.encryptionMode === "aead_aes256_gcm_rtpsize") {
      const cipher = crypto.createCipheriv("aes-256-gcm", this.secretKey, this.nonceBuffer);
      cipher.setAAD(header);
      return {
        cipherText: Buffer.concat([cipher.update(opusFrame), cipher.final(), cipher.getAuthTag()]),
        noncePadding,
      };
    }

    const cipher = xchacha20poly1305(this.secretKey, this.nonceBuffer, header);
    return {
      cipherText: Buffer.from(cipher.encrypt(opusFrame)),
      noncePadding,
    };
  }

  private finishPlayback(): void {
    const activePlayback = this.playback;
    this.stop();
    if (activePlayback) {
      this.callbacks.onPlaybackFinished?.(activePlayback.playbackId);
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.speaking = speaking;
    this.sendJson(VoiceGatewayOpcode.Speaking, {
      speaking: speaking ? 1 : 0,
      delay: 0,
      ssrc: this.ssrc,
    });
  }

  private chooseEncryptionMode(modes: string[]): SupportedEncryptionMode {
    if (crypto.getCiphers().includes("aes-256-gcm") && modes.includes("aead_aes256_gcm_rtpsize")) {
      return "aead_aes256_gcm_rtpsize";
    }
    if (modes.includes("aead_xchacha20_poly1305_rtpsize")) {
      return "aead_xchacha20_poly1305_rtpsize";
    }
    throw new Error(`No supported voice encryption mode was offered. Available: ${modes.join(", ")}`);
  }

  private isPlaybackReady(): boolean {
    return this.daveSession.currentProtocolVersion === 0 || this.daveSession.ready;
  }

  private sendJson(op: number, data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const packet = JSON.stringify({ op, d: data });
    this.log(`[voice] [WS] >> ${packet}`);
    this.ws.send(packet);
  }

  private sendBinary(op: number, body: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const packet = Buffer.allocUnsafe(1 + body.length);
    packet.writeUInt8(op, 0);
    body.copy(packet, 1);
    this.log(`[voice] [WS] >> binary op=${op} bytes=${packet.length}`);
    this.ws.send(packet);
  }

  private setConnectionState(state: VoiceConnectionState): void {
    if (this.connectionState === state) {
      return;
    }

    this.connectionState = state;
    this.callbacks.onConnectionStateChange?.(state);
  }

  private setPlaybackState(state: VoicePlaybackState): void {
    if (this.playbackState === state) {
      return;
    }

    this.playbackState = state;
    this.callbacks.onPlaybackStateChange?.(state);
  }

  private cleanupNetwork(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.udpKeepAliveInterval) {
      clearInterval(this.udpKeepAliveInterval);
      this.udpKeepAliveInterval = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // Ignore shutdown failures.
      }
      this.ws = null;
    }
    if (this.udp) {
      this.udp.removeAllListeners();
      try {
        this.udp.close();
      } catch {
        // Ignore shutdown failures.
      }
      this.udp = null;
    }
    this.udpRemoteIp = null;
    this.udpRemotePort = null;
  }

  private sendUdpPacket(packet: Buffer): void {
    if (!this.udp || !this.udpRemoteIp || !this.udpRemotePort) {
      throw new Error("Voice UDP transport is not ready to send packets yet.");
    }

    this.udp.send(packet, this.udpRemotePort, this.udpRemoteIp);
  }

  private resolveConnect(): void {
    this.clearConnectTimeout();
    const resolve = this.connectResolver;
    this.connectPromise = null;
    this.connectResolver = null;
    this.connectRejecter = null;
    resolve?.();
  }

  private rejectConnect(error: Error): void {
    if (!this.connectRejecter) {
      return;
    }

    this.clearConnectTimeout();
    const reject = this.connectRejecter;
    this.connectPromise = null;
    this.connectResolver = null;
    this.connectRejecter = null;
    reject(error);
  }

  private clearConnectTimeout(): void {
    if (!this.connectTimeout) {
      return;
    }

    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  private log(message: string): void {
    this.callbacks.onDiagnostic?.(message);
  }

  private clearPlaybackTimer(playback: PlaybackSession): void {
    if (playback.ticker) {
      playback.tickerTerminationExpected = true;
      playback.ticker.postMessage({ type: "stop" });
      void playback.ticker.terminate().catch(() => {});
      playback.ticker = null;
    }

    if (!playback.timer || !playback.timerKind) {
      return;
    }

    if (playback.timerKind === "immediate") {
      clearImmediate(playback.timer as NodeJS.Immediate);
    } else {
      clearTimeout(playback.timer as NodeJS.Timeout);
    }

    playback.timer = null;
    playback.timerKind = null;
  }

  private logTiming(message: string): void {
    if (!this.callbacks.shouldLogTimingDebug?.()) {
      return;
    }
    this.log(`[timing] ${message}`);
  }

  private createTimingStats(): TimingStats {
    return {
      packets: 0,
      anomalies: 0,
      lastSendAt: null,
      deltaSumMs: 0,
      deltaMinMs: Number.POSITIVE_INFINITY,
      deltaMaxMs: 0,
      lateSumMs: 0,
      lateMaxMs: 0,
      queueMin: Number.POSITIVE_INFINITY,
      queueMax: 0,
    };
  }

  private recordTimingSample(sentAt: number, queueDepth: number, scheduledAt: number): void {
    const stats = this.timingStats;
    stats.packets += 1;
    stats.queueMin = Math.min(stats.queueMin, queueDepth);
    stats.queueMax = Math.max(stats.queueMax, queueDepth);

    const lateMs = Math.max(0, sentAt - scheduledAt);
    stats.lateSumMs += lateMs;
    stats.lateMaxMs = Math.max(stats.lateMaxMs, lateMs);

    let deltaMs: number | null = null;
    if (stats.lastSendAt !== null) {
      deltaMs = sentAt - stats.lastSendAt;
      stats.deltaSumMs += deltaMs;
      stats.deltaMinMs = Math.min(stats.deltaMinMs, deltaMs);
      stats.deltaMaxMs = Math.max(stats.deltaMaxMs, deltaMs);
    }
    stats.lastSendAt = sentAt;

    const isAnomalous = (deltaMs !== null && (deltaMs < 12 || deltaMs > 28)) || lateMs > 12;
    const isSevere =
      (deltaMs !== null && (deltaMs < 8 || deltaMs > 40))
      || lateMs > 20;
    if (isAnomalous) {
      stats.anomalies += 1;
      if (isSevere) {
        this.logTiming(
          `packet=${stats.packets} delta=${deltaMs?.toFixed(2) ?? "n/a"}ms late=${lateMs.toFixed(2)}ms queue=${queueDepth}`,
        );
      }
    } else if (stats.packets % TIMING_SUMMARY_INTERVAL_PACKETS === 0) {
      const avgDeltaMs = stats.packets > 1 ? stats.deltaSumMs / (stats.packets - 1) : 0;
      const avgLateMs = stats.lateSumMs / stats.packets;
      this.logTiming(
        `summary packets=${stats.packets} avg_delta=${avgDeltaMs.toFixed(2)}ms min_delta=${(Number.isFinite(stats.deltaMinMs) ? stats.deltaMinMs : 0).toFixed(2)}ms max_delta=${stats.deltaMaxMs.toFixed(2)}ms avg_late=${avgLateMs.toFixed(2)}ms max_late=${stats.lateMaxMs.toFixed(2)}ms queue=${stats.queueMin}-${stats.queueMax} anomalies=${stats.anomalies}`,
      );
      this.timingStats = this.createTimingStats();
    }
  }

}
