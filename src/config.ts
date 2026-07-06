import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { AppConfig, GuildConfig, RuntimePaths } from "./types.js";

const DEFAULT_GUILD_CONFIG: GuildConfig = {
  admins: [],
  commandChannels: [],
  pingRoleId: null,
  channelWhitelist: [],
  blockedUsers: [],
};

const DEFAULT_CONFIG: AppConfig = {
  debug: true,
  prefix: "!",
  enabledCogs: ["manager", "music", "utility", "events", "record", "chat", "ytdlp", "webPanel"],
  runtime: {
    ffmpegPath: "ffmpeg",
    ytDlpPath: "yt-dlp",
    legacyDatabaseImportPath: null,
  },
  discord: {
    token: "",
    ownerId: "",
    intents: ["Guilds", "GuildMessages", "GuildVoiceStates", "MessageContent"],
  },
  spotify: {
    enabled: false,
    clientId: "",
    clientSecret: "",
  },
  events: {
    lookaheadDays: 21,
    lookbackDays: 2,
    defaultDurationMinutes: 240,
  },
  music: {
    idleDisconnectMs: 120000,
    shouldLeaveWhenIdle: true,
    timingDebugDefault: false,
  },
  webPanel: {
    enabled: true,
    port: 3000,
    token: "",
  },
  guildDefaults: DEFAULT_GUILD_CONFIG,
  guilds: {},
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return (override ?? base) as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

function normalizeConfiguredPath(value: string | null | undefined, root: string): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".")) {
    return path.resolve(root, trimmed);
  }

  return trimmed;
}

export class ConfigStore {
  constructor(private readonly paths: RuntimePaths) {}

  load(): AppConfig {
    dotenv.config({ path: path.join(this.paths.root, ".env") });
    this.ensureRuntimeDirectories();

    if (!fs.existsSync(this.paths.configFile)) {
      fs.writeFileSync(this.paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }

    const raw = JSON.parse(fs.readFileSync(this.paths.configFile, "utf8"));
    const merged = deepMerge(DEFAULT_CONFIG, raw);

    merged.runtime.ffmpegPath = normalizeConfiguredPath(process.env.FFMPEG_PATH || merged.runtime.ffmpegPath, this.paths.root) ?? "ffmpeg";
    merged.runtime.ytDlpPath = normalizeConfiguredPath(process.env.YTDLP_PATH || merged.runtime.ytDlpPath, this.paths.root) ?? "yt-dlp";
    merged.runtime.legacyDatabaseImportPath = normalizeConfiguredPath(
      process.env.LEGACY_DATABASE_IMPORT_PATH || merged.runtime.legacyDatabaseImportPath,
      this.paths.root,
    );
    merged.discord.token = process.env.DISCORD_TOKEN || merged.discord.token;
    merged.discord.ownerId = process.env.BOT_OWNER_ID || merged.discord.ownerId;
    merged.spotify.clientId = process.env.SPOTIFY_CLIENT_ID || merged.spotify.clientId;
    merged.spotify.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || merged.spotify.clientSecret;
    merged.webPanel.token = process.env.WEB_PANEL_TOKEN || merged.webPanel.token;

    if (!merged.discord.token) {
      throw new Error("Missing Discord token. Set DISCORD_TOKEN or config.discord.token.");
    }

    return merged;
  }

  save(config: AppConfig): void {
    fs.writeFileSync(this.paths.configFile, JSON.stringify(config, null, 2));
  }

  getGuildConfig(config: AppConfig, guildId: string): GuildConfig {
    return deepMerge(config.guildDefaults, config.guilds[guildId] ?? {});
  }

  upsertGuildConfig(config: AppConfig, guildId: string, patch: Partial<GuildConfig>): AppConfig {
    const next = structuredClone(config);
    next.guilds[guildId] = deepMerge(next.guilds[guildId] ?? {}, patch);
    this.save(next);
    return next;
  }

  ensureGuildEntry(config: AppConfig, guildId: string): AppConfig {
    if (config.guilds[guildId]) {
      return config;
    }
    const next = structuredClone(config);
    next.guilds[guildId] = {};
    this.save(next);
    return next;
  }

  private ensureRuntimeDirectories(): void {
    for (const dir of [
      this.paths.configDir,
      this.paths.logsDir,
      this.paths.downloadsDir,
      this.paths.tempDir,
      this.paths.ytdlpTempDir,
      this.paths.audioDir,
      this.paths.recordingsDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
