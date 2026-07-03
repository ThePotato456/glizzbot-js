import type { Guild, GuildMember, Message, Snowflake, TextBasedChannel } from "discord.js";

export interface GuildConfig {
  admins: string[];
  commandChannels: string[];
  pingRoleId: string | null;
  channelWhitelist: string[];
  blockedUsers: string[];
}

export interface AppConfig {
  debug: boolean;
  prefix: string;
  enabledCogs: string[];
  discord: {
    token: string;
    ownerId: string;
    intents: string[];
  };
  spotify: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
  };
  events: {
    lookaheadDays: number;
    lookbackDays: number;
    defaultDurationMinutes: number;
  };
  music: {
    idleDisconnectMs: number;
    shouldLeaveWhenIdle: boolean;
    timingDebugDefault: boolean;
  };
  webPanel: {
    enabled: boolean;
    port: number;
    token: string;
  };
  guildDefaults: GuildConfig;
  guilds: Record<string, Partial<GuildConfig>>;
}

export interface RuntimePaths {
  root: string;
  configDir: string;
  configFile: string;
  databaseFile: string;
  downloadsDir: string;
  tempDir: string;
  ytdlpTempDir: string;
  audioDir: string;
  recordingsDir: string;
  soundsManifestFile: string;
  discordLogFile: string;
}

export interface CommandContext {
  message: Message;
  args: string[];
  rawArgs: string;
  guild: Guild | null;
  member: GuildMember | null;
  channel: TextBasedChannel;
  reply: (content: string) => Promise<Message>;
}

export interface BotCommand {
  name: string;
  aliases?: string[];
  description: string;
  cog: string;
  ownerOnly?: boolean;
  guildOnly?: boolean;
  execute: (ctx: CommandContext) => Promise<void>;
}

export type QueueSourceType =
  | "url"
  | "search"
  | "spotify"
  | "youtubePlaylist"
  | "spotifyPlaylist"
  | "spotifyAlbum";

export interface QueueItem {
  id: string;
  title: string;
  url: string;
  requestedBy: string;
  durationSeconds?: number;
  isResolved: boolean;
  sourceType: QueueSourceType;
  streamUrl?: string;
  resolverNote?: string;
  prefetchedAt?: number;
  addedAt: number;
}

export interface MusicState {
  guildId: string;
  queue: QueueItem[];
  current: QueueItem | null;
  isPaused: boolean;
  voiceChannelId: Snowflake | null;
  textChannelId: Snowflake | null;
  connectionStatus: "disconnected" | "connecting" | "connected" | "idle-disconnect-pending";
  playbackStatus: "idle" | "playing" | "paused" | "placeholder";
  shouldLeave: boolean;
  timingDebug: boolean;
  startedAt: number | null;
  lastStopReason: string | null;
  incidentMarks: Array<{ at: number; note: string }>;
}

export interface ExternalEventRecord {
  id: string;
  title: string;
  startsAt: string;
  venue?: string;
  city?: string;
  country?: string;
  imageUrl?: string;
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
