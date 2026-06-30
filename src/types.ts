import type {
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Message,
  TextBasedChannel,
} from "discord.js";

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
  ownerOnly?: boolean;
  guildOnly?: boolean;
  execute: (ctx: CommandContext) => Promise<void>;
}

export interface QueueItem {
  id: string;
  title: string;
  url: string;
  requestedBy: string;
  durationSeconds?: number;
  isResolved: boolean;
  sourceType: "url" | "search" | "spotify" | "sound" | "local";
  streamUrl?: string;
  localFile?: string;
  addedAt: number;
}

export interface MusicState {
  guildId: string;
  queue: QueueItem[];
  current: QueueItem | null;
  isPaused: boolean;
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
