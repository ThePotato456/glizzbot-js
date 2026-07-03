import type { GuildMember } from "discord.js";
import type { Readable } from "node:stream";

export type VoiceConnectionState = "connecting" | "connected" | "disconnected";
export type VoicePlaybackState = "idle" | "playing" | "paused";

export interface VoiceTransportCallbacks {
  onDiagnostic?: (message: string) => void;
  onConnectionStateChange?: (state: VoiceConnectionState) => void;
  onPlaybackStateChange?: (state: VoicePlaybackState) => void;
  onPlaybackFinished?: () => void;
  onPlaybackError?: (error: Error) => void;
  shouldLogTimingDebug?: () => boolean;
}

export interface VoiceTransport {
  readonly channelId: string;
  readonly guildId: string;
  connect(): Promise<void>;
  disconnect(): void;
  play(stream: Readable): void;
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
