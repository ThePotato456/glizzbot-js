import type { GuildMember } from "discord.js";
import type { Readable } from "node:stream";

export type VoiceConnectionState = "connecting" | "connected" | "recovering" | "disconnected";
export type VoicePlaybackState = "idle" | "playing" | "paused";

export interface VoiceTransportCallbacks {
  onDiagnostic?: (message: string) => void;
  onConnectionStateChange?: (state: VoiceConnectionState) => void;
  onPlaybackStateChange?: (state: VoicePlaybackState) => void;
  onPlaybackFinished?: (playbackId: string | null) => void;
  onPlaybackError?: (error: Error, playbackId: string | null) => void;
  shouldLogTimingDebug?: () => boolean;
}

export interface VoiceTransport {
  readonly channelId: string;
  readonly guildId: string;
  connect(): Promise<void>;
  disconnect(): void;
  play(stream: Readable, playbackId?: string | null): void;
  pause(): boolean;
  resume(): boolean;
  stop(): void;
  isConnected(): boolean;
  getDebugState(): string;
}

export type VoiceTransportFactory = (
  member: GuildMember,
  callbacks: VoiceTransportCallbacks,
) => VoiceTransport;
