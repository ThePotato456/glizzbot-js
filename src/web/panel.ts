import fs from "node:fs";
import type { Stats } from "node:fs";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { ChannelType, type GuildBasedChannel, type Role } from "discord.js";
import type { GlizzBot } from "../bot.js";
import type { AppConfig, GuildConfig } from "../types.js";

type HealthLevel = "ok" | "warn" | "error";

interface GuildConfigPatchPayload {
  admins?: unknown;
  commandChannels?: unknown;
  pingRoleId?: unknown;
  channelWhitelist?: unknown;
  blockedUsers?: unknown;
}

const DISCORD_WS_STATUS_LABELS: Record<number, string> = {
  0: "ready",
  1: "connecting",
  2: "reconnecting",
  3: "idle",
  4: "nearly",
  5: "disconnected",
};

function authMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      next();
      return;
    }
    const candidate = req.header("x-panel-token") ?? String(req.query.token ?? "");
    if (candidate !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function uniqueStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings.`);
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  if (normalized.length !== value.length) {
    throw new Error(`${field} must only contain non-empty strings.`);
  }

  return [...new Set(normalized)];
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or null.`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function validateGuildConfigPatch(payload: GuildConfigPatchPayload): Partial<GuildConfig> {
  const patch: Partial<GuildConfig> = {};

  if ("admins" in payload) {
    patch.admins = uniqueStringArray(payload.admins, "admins");
  }
  if ("commandChannels" in payload) {
    patch.commandChannels = uniqueStringArray(payload.commandChannels, "commandChannels");
  }
  if ("pingRoleId" in payload) {
    patch.pingRoleId = normalizeOptionalString(payload.pingRoleId, "pingRoleId");
  }
  if ("channelWhitelist" in payload) {
    patch.channelWhitelist = uniqueStringArray(payload.channelWhitelist, "channelWhitelist");
  }
  if ("blockedUsers" in payload) {
    patch.blockedUsers = uniqueStringArray(payload.blockedUsers, "blockedUsers");
  }

  return patch;
}

function safeStat(path: string): Stats | null {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}

function summarizePath(path: string): { path: string; exists: boolean; sizeBytes: number | null; modifiedAt: string | null } {
  const stat = safeStat(path);
  return {
    path,
    exists: Boolean(stat),
    sizeBytes: stat?.size ?? null,
    modifiedAt: stat?.mtime.toISOString() ?? null,
  };
}

function inferHealthLevel(bot: GlizzBot): HealthLevel {
  const lagMs = bot.getLagMs();
  const pingMs = bot.ws.ping;
  const recentLogs = bot.logger.buffer.snapshot().slice(-25);
  const hasRecentErrors = recentLogs.some((line) => line.level === "error");

  if (bot.ws.status !== 0 || hasRecentErrors || lagMs >= 500 || pingMs >= 1000) {
    return "error";
  }
  if (lagMs >= 150 || pingMs >= 250) {
    return "warn";
  }
  return "ok";
}

function getHealthSignals(bot: GlizzBot) {
  const lagMs = bot.getLagMs();
  const pingMs = bot.ws.ping;
  const memory = process.memoryUsage();
  const recentLogs = bot.logger.buffer.snapshot().slice(-100);
  const recentErrorCount = recentLogs.filter((line) => line.level === "error").length;
  const connectedMusicStates = bot.music.exportState().filter((state) => state.connectionStatus !== "disconnected");

  return {
    level: inferHealthLevel(bot),
    checkedAt: new Date().toISOString(),
    gateway: {
      status: DISCORD_WS_STATUS_LABELS[bot.ws.status] ?? `unknown:${bot.ws.status}`,
      pingMs,
    },
    eventLoop: {
      lagMs,
    },
    process: {
      uptimeSeconds: process.uptime(),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      nodeVersion: process.version,
      pid: process.pid,
    },
    recentErrors: {
      count: recentErrorCount,
      last: recentLogs.filter((line) => line.level === "error").slice(-1)[0] ?? null,
    },
    discord: {
      loggedInUser: bot.user?.tag ?? null,
      guildCount: bot.guilds.cache.size,
    },
    music: {
      activeGuildCount: connectedMusicStates.length,
      idleDisconnectMs: bot.music.getIdleDisconnectMs(),
    },
  };
}

function summarizeChannel(channel: GuildBasedChannel) {
  return {
    id: channel.id,
    name: channel.name,
    type: ChannelType[channel.type] ?? String(channel.type),
  };
}

function getChannelSortPosition(channel: GuildBasedChannel): number {
  const value = Reflect.get(channel as object, "rawPosition");
  return typeof value === "number" ? value : 0;
}

function summarizeRole(role: Role) {
  return {
    id: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
  };
}

function getGuildSummary(bot: GlizzBot, guildId: string) {
  const guild = bot.guilds.cache.get(guildId);
  if (!guild) {
    return null;
  }

  const config = bot.configStore.getGuildConfig(bot.config, guildId);
  const musicState = bot.music.getState(guildId);

  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL(),
    memberCount: guild.memberCount,
    joinedAt: guild.joinedAt?.toISOString() ?? null,
    preferredLocale: guild.preferredLocale,
    config,
    music: {
      connectionStatus: musicState.connectionStatus,
      playbackStatus: musicState.playbackStatus,
      currentTrack: musicState.current
        ? {
            title: musicState.current.title,
            url: musicState.current.url,
            requestedBy: musicState.current.requestedBy,
          }
        : null,
      queueLength: musicState.queue.length,
      voiceChannelId: musicState.voiceChannelId,
      textChannelId: musicState.textChannelId,
      lastStopReason: musicState.lastStopReason,
    },
  };
}

function getGuildDetail(bot: GlizzBot, guildId: string) {
  const guild = bot.guilds.cache.get(guildId);
  if (!guild) {
    return null;
  }

  const mergedConfig = bot.configStore.getGuildConfig(bot.config, guildId);
  const storedPatch = bot.config.guilds[guildId] ?? {};
  const musicState = bot.music.getState(guildId);
  const diagnostics = bot.music.getDiagnostics(guildId);
  const channels = guild.channels.cache
    .filter((channel) => "name" in channel)
    .sort((a, b) => getChannelSortPosition(a) - getChannelSortPosition(b) || a.name.localeCompare(b.name))
    .map((channel) => summarizeChannel(channel));
  const roles = guild.roles.cache
    .sort((a, b) => b.position - a.position)
    .map((role) => summarizeRole(role));

  return {
    summary: getGuildSummary(bot, guildId),
    config: {
      merged: mergedConfig,
      storedPatch,
      defaults: bot.config.guildDefaults,
    },
    channels,
    roles,
    diagnostics,
    musicState,
    voiceSummary: bot.music.getVoiceSummary(guildId),
  };
}

function buildStatusPayload(bot: GlizzBot) {
  const loadedCommands = [...new Set([...bot.commands.values()].map((command) => command.name))].sort();
  const guilds = bot.guilds.cache
    .map((guild) => getGuildSummary(bot, guild.id))
    .filter((guild): guild is NonNullable<typeof guild> => Boolean(guild))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    user: bot.user?.tag ?? null,
    prefix: bot.config.prefix,
    enabledCogs: [...bot.config.enabledCogs],
    loadedCommands,
    health: getHealthSignals(bot),
    guilds,
    musicStates: bot.music.exportState(),
    logs: bot.logger.buffer.snapshot().slice(-80),
  };
}

function buildExportPayload(bot: GlizzBot) {
  const guildDetails = bot.guilds.cache
    .map((guild) => getGuildDetail(bot, guild.id))
    .filter((guild): guild is NonNullable<typeof guild> => Boolean(guild));

  return {
    exportedAt: new Date().toISOString(),
    configSnapshot: bot.config,
    health: getHealthSignals(bot),
    status: buildStatusPayload(bot),
    guilds: guildDetails,
    logs: bot.logger.buffer.snapshot(),
    runtimePaths: {
      config: summarizePath(bot.paths.configFile),
      database: summarizePath(bot.paths.databaseFile),
      discordLog: summarizePath(bot.paths.discordLogFile),
      sessionLog: summarizePath(bot.paths.sessionLogFile),
    },
    memoryUsage: process.memoryUsage(),
    uptimeSeconds: process.uptime(),
  };
}

function buildPanelHtml(config: AppConfig): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GlizzBot Control Panel</title>
    <style>
      :root {
        --bg: #0b0914;
        --bg-alt: #171226;
        --card: rgba(20, 17, 35, 0.94);
        --card-soft: rgba(34, 28, 56, 0.78);
        --text: #f4f1ff;
        --muted: #afa5d7;
        --accent: #8b5cf6;
        --accent-strong: #6d28d9;
        --accent-soft: rgba(139, 92, 246, 0.16);
        --good: #33d17a;
        --warn: #ffd166;
        --bad: #ff6b6b;
        --border: rgba(173, 154, 255, 0.16);
        --shadow: 0 8px 22px rgba(2, 0, 12, 0.16);
        --radius: 4px;
        --font: "Segoe UI", "IBM Plex Sans", sans-serif;
        --terminal-bg: #09070f;
        --terminal-text: #cbb8ff;
        --terminal-border: rgba(139, 92, 246, 0.18);
        --code-text: #d8c7ff;
      }
      body[data-theme="light"] {
        --bg: #f4f0ff;
        --bg-alt: #ebe4ff;
        --card: rgba(255, 255, 255, 0.94);
        --card-soft: rgba(241, 235, 255, 0.92);
        --text: #231942;
        --muted: #6d6390;
        --accent: #7c3aed;
        --accent-strong: #5b21b6;
        --accent-soft: rgba(124, 58, 237, 0.12);
        --border: rgba(91, 33, 182, 0.14);
        --shadow: 0 8px 22px rgba(93, 63, 211, 0.08);
        --terminal-bg: #f6f2ff;
        --terminal-text: #4c1d95;
        --terminal-border: rgba(124, 58, 237, 0.18);
        --code-text: #5b21b6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--font);
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(139,92,246,0.24), transparent 28%),
          radial-gradient(circle at top right, rgba(167,139,250,0.18), transparent 24%),
          linear-gradient(160deg, var(--bg) 0%, var(--bg-alt) 48%, var(--bg) 100%);
        min-height: 100vh;
      }
      a { color: inherit; }
      .shell {
        display: grid;
        grid-template-columns: 256px minmax(0, 1fr);
        gap: 10px;
        min-height: 100vh;
        padding: 8px;
      }
      .sidebar {
        position: sticky;
        top: 8px;
        align-self: start;
        height: calc(100vh - 16px);
        display: grid;
        grid-template-rows: auto auto auto auto;
        gap: 8px;
      }
      .sidebarIntro {
        padding: 8px 10px;
      }
      .mainContent {
        min-width: 0;
        display: grid;
        gap: 10px;
        padding-bottom: 8px;
      }
      .hero {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .panel, .heroCard {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(8px);
      }
      .heroCard {
        padding: 10px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--accent);
        font-size: 11px;
        font-weight: 700;
      }
      h1 {
        margin: 4px 0 2px;
        font-size: clamp(1.2rem, 2.5vw, 2rem);
        line-height: 1.02;
      }
      .subtitle {
        color: var(--muted);
        max-width: 72ch;
        line-height: 1.28;
        font-size: 0.86rem;
      }
      .heroStats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-top: 8px;
      }
      .statTile {
        background: var(--card-soft);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 8px;
      }
      .statTile label {
        display: block;
        color: var(--muted);
        font-size: 11px;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .statTile strong {
        font-size: 0.98rem;
      }
      .panel {
        overflow: hidden;
      }
      .panelHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
      }
      .panelHeader h2 {
        margin: 0;
        font-size: 0.92rem;
      }
      .panelBody {
        padding: 10px 12px 12px;
      }
      .stack {
        display: grid;
        gap: 10px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 5px 9px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: var(--accent-soft);
        color: var(--accent);
      }
      .badge.ok { background: rgba(51, 209, 122, 0.12); color: var(--good); }
      .badge.warn { background: rgba(255, 209, 102, 0.14); color: var(--warn); }
      .badge.error { background: rgba(255, 107, 107, 0.12); color: var(--bad); }
      .guildList {
        display: grid;
        gap: 6px;
        align-content: start;
        max-height: 100%;
        overflow: auto;
        padding-right: 2px;
      }
      .guildButton {
        width: 100%;
        text-align: left;
        background: var(--card-soft);
        color: var(--text);
        border: 1px solid transparent;
        border-radius: var(--radius);
        padding: 9px 10px;
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
      }
      .guildButton:hover, .guildButton.active {
        transform: translateX(1px);
        border-color: rgba(139, 92, 246, 0.42);
        background: rgba(139, 92, 246, 0.12);
        box-shadow: inset 0 0 0 1px rgba(139, 92, 246, 0.16);
      }
      .guildButton strong {
        display: block;
        margin-bottom: 4px;
        font-size: 0.86rem;
      }
      .guildButton span {
        display: block;
        color: var(--muted);
        font-size: 11px;
      }
      .guildMeta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-top: 6px;
      }
      .guildPill {
        display: inline-flex;
        align-items: center;
        border-radius: var(--radius);
        padding: 3px 6px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: rgba(255,255,255,0.06);
        color: var(--muted);
      }
      .grid {
        display: grid;
        gap: 8px;
      }
      .grid.cols3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .grid.cols2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .miniCard {
        background: var(--card-soft);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 8px;
      }
      .miniCard label {
        color: var(--muted);
        display: block;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 8px;
      }
      .miniCard strong {
        font-size: 1rem;
      }
      .sectionTitle {
        margin: 0 0 12px;
        font-size: 0.95rem;
      }
      .detailColumns {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 10px;
      }
      .tabBar {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      .tabButton {
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.04);
        color: var(--muted);
        border-radius: var(--radius);
        padding: 7px 9px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
      }
      .tabButton:hover, .tabButton.active {
        background: rgba(139, 92, 246, 0.12);
        color: var(--text);
        border-color: rgba(139, 92, 246, 0.38);
      }
      .summaryStrip {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-bottom: 10px;
      }
      .contentStack {
        display: grid;
        gap: 10px;
      }
      .overviewLayout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 0.82fr);
        gap: 18px;
      }
      .sidebarTitle {
        display: grid;
        gap: 3px;
      }
      .sidebarTitle h1 {
        margin: 0;
        font-size: 0.92rem;
        line-height: 1;
      }
      .sidebarTitle p {
        margin: 0;
        color: var(--muted);
        line-height: 1.2;
        font-size: 0.7rem;
      }
      .serverCountCard {
        display: grid;
        gap: 2px;
        padding: 8px 10px;
      }
      .serverCountLabel {
        color: var(--muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .serverCountValue {
        font-size: 1rem;
        font-weight: 800;
        line-height: 1;
        color: var(--text);
      }
      .railSection {
        display: grid;
      }
      .railSection .panelBody {
        display: grid;
      }
      .serverListPanel .panelBody {
        padding-bottom: 10px;
      }
      .serverListPanel .guildList {
        max-height: min(42vh, 420px);
      }
      .railFooter {
        display: grid;
        gap: 8px;
      }
      .compactGrid {
        display: grid;
        gap: 6px;
      }
      .runtimePanel .panelBody,
      .logsPanel .panelBody {
        padding-top: 10px;
      }
      .runtimePanelBody {
        display: grid;
        gap: 8px;
      }
      .runtimeMetaGrid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }
      .runtimeControls {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
      }
      .topBarActions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .poller {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .pollerLabel {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 700;
      }
      .intervalButton {
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.05);
        color: var(--muted);
        border-radius: var(--radius);
        padding: 6px 9px;
        font: inherit;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .intervalButton.active {
        background: rgba(139, 92, 246, 0.14);
        border-color: rgba(139, 92, 246, 0.38);
        color: var(--text);
      }
      .themeToggle {
        border: 1px solid var(--border);
        background: var(--card-soft);
        color: var(--text);
        border-radius: var(--radius);
        padding: 6px 9px;
        font: inherit;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .terminalBox {
        width: 100%;
        min-height: min(44vh, 460px);
        border-radius: var(--radius);
        border: 1px solid var(--terminal-border);
        background: var(--terminal-bg);
        color: var(--terminal-text);
        padding: 10px;
        font: 11px/1.45 Consolas, "Courier New", monospace;
        resize: vertical;
        white-space: pre;
      }
      .diagnosticTerminal {
        min-height: 220px;
      }
      .runtimeNote {
        color: var(--muted);
        font-size: 11px;
      }
      .tokenField, input, textarea, select {
        width: 100%;
        border-radius: var(--radius);
        border: 1px solid var(--border);
        background: rgba(8, 14, 22, 0.45);
        color: var(--text);
        padding: 8px 10px;
        font: inherit;
      }
      textarea {
        min-height: 68px;
        resize: vertical;
      }
      .field {
        display: grid;
        gap: 6px;
        margin-bottom: 10px;
      }
      .field label {
        font-size: 12px;
        color: var(--muted);
      }
      .helper {
        color: var(--muted);
        font-size: 11px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      button.primary, button.secondary {
        border: 0;
        border-radius: var(--radius);
        padding: 7px 10px;
        color: #f7f4ff;
        font-weight: 700;
        cursor: pointer;
      }
      button.primary { background: linear-gradient(180deg, var(--accent), var(--accent-strong)); }
      button.secondary {
        background: var(--card-soft);
        color: var(--text);
        border: 1px solid var(--border);
      }
      .list, .logList {
        display: grid;
        gap: 6px;
      }
      .listItem, .logLine {
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 8px;
      }
      .listItem code, .logLine code {
        color: var(--code-text);
        word-break: break-word;
      }
      .muted {
        color: var(--muted);
      }
      .empty {
        color: var(--muted);
        padding: 14px;
        border: 1px dashed var(--border);
        border-radius: var(--radius);
        text-align: center;
      }
      .message {
        min-height: 22px;
        font-size: 12px;
      }
      .message.error { color: var(--bad); }
      .message.success { color: var(--good); }
      .toolbar {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .logLineHeader {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
        font-size: 12px;
        color: var(--muted);
      }
      @media (max-width: 1200px) {
        .shell {
          grid-template-columns: 232px minmax(0, 1fr);
        }
        .hero, .overviewLayout, .detailColumns, .grid.cols3, .grid.cols2, .summaryStrip, .heroStats, .runtimeMetaGrid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 940px) {
        .shell {
          grid-template-columns: 1fr;
          padding: 8px;
        }
        .sidebar {
          position: static;
          height: auto;
          grid-template-rows: none;
        }
        .mainContent {
          order: 2;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="heroCard sidebarIntro">
          <div class="eyebrow">GlizzBot Ops</div>
          <div class="sidebarTitle">
            <h1>Guild Control</h1>
            <p>Pick a server from the rail and manage its runtime, health, and configuration from one steady workspace.</p>
          </div>
        </div>
        <div class="heroCard serverCountCard">
          <span class="serverCountLabel">Servers</span>
          <span class="serverCountValue" id="guildCountLabel">0</span>
        </div>
        <div class="panel railSection serverListPanel">
          <div class="panelHeader">
            <h2>Server list</h2>
            <span class="muted">Select one</span>
          </div>
          <div class="panelBody">
            <div class="guildList" id="guildList"></div>
          </div>
        </div>
        <div class="railFooter">
          <div class="heroCard">
            <div class="runtimeNote">Auth token is read from the page URL query string: <code>?token=...</code></div>
            <div class="actions" style="margin-top:10px;">
              <button class="themeToggle" id="themeToggle" type="button">Toggle theme</button>
            </div>
          </div>
        </div>
      </aside>

      <main class="mainContent">
        <section class="hero">
          <div class="panel runtimePanel">
            <div class="panelHeader">
              <div>
                <div class="eyebrow">Control Surface</div>
                <h1>Live runtime telemetry and guild operations in one place.</h1>
                <p class="subtitle">All runtime signals, refresh controls, and bot metadata stay grouped here while the left rail remains focused on server selection.</p>
              </div>
              <div id="healthBadgeSlot"><span class="badge" id="healthBadge">Loading</span></div>
            </div>
            <div class="panelBody runtimePanelBody">
              <div class="runtimeControls">
                <div class="poller">
                  <span class="pollerLabel">Auto refresh</span>
                  <button class="intervalButton" type="button" data-interval-seconds="2">2s</button>
                  <button class="intervalButton active" type="button" data-interval-seconds="5">5s</button>
                  <button class="intervalButton" type="button" data-interval-seconds="10">10s</button>
                </div>
                <div class="topBarActions">
                  <span class="muted" id="lastUpdated">Waiting for data</span>
                  <button class="primary" id="refreshButton" type="button">Refresh now</button>
                  <a class="secondary" id="exportLink" href="/api/export" target="_blank" rel="noreferrer" style="text-decoration:none;display:inline-flex;align-items:center;">Open export JSON</a>
                </div>
              </div>
              <div class="heroStats" id="heroStats"></div>
              <div class="runtimeMetaGrid" id="sessionGrid"></div>
              <div class="runtimeMetaGrid" id="overviewCards"></div>
              <div class="runtimeMetaGrid" id="healthSignals"></div>
            </div>
          </div>
        </section>

        <section class="contentStack">
          <div class="panel">
            <div class="panelHeader">
              <h2 id="guildTitle">Guild details</h2>
              <span class="muted" id="guildSubtitle">Select a guild to inspect its configuration and runtime state.</span>
            </div>
            <div class="panelBody" id="guildDetailRoot">
              <div class="empty">Select a guild from the left to load configuration, connection status, diagnostics, and channel metadata.</div>
            </div>
          </div>

          <div class="panel logsPanel">
            <div class="panelHeader">
              <h2>Terminal output</h2>
              <span class="muted">Buffered runtime logs</span>
            </div>
            <div class="panelBody">
              <textarea id="terminalOutput" class="terminalBox" readonly spellcheck="false"></textarea>
            </div>
          </div>
        </section>
      </main>
    </div>

    <script>
      const state = {
        token: "",
        status: null,
        selectedGuildId: null,
        selectedGuildDetail: null,
        selectedGuildTab: "overview",
        refreshSeconds: 5,
        refreshTimer: null,
      };

      const refreshButton = document.getElementById("refreshButton");
      const exportLink = document.getElementById("exportLink");
      const themeToggle = document.getElementById("themeToggle");

      function applyTheme(theme) {
        document.body.dataset.theme = theme === "light" ? "light" : "dark";
        if (themeToggle) {
          themeToggle.textContent = document.body.dataset.theme === "light" ? "Dark mode" : "Light mode";
        }
      }

      function toggleTheme() {
        const nextTheme = document.body.dataset.theme === "light" ? "dark" : "light";
        localStorage.setItem("glizzbot-panel-theme", nextTheme);
        applyTheme(nextTheme);
      }

      function setToken(token) {
        state.token = token.trim();
        const exportUrl = new URL("/api/export", window.location.origin);
        if (state.token) {
          exportUrl.searchParams.set("token", state.token);
        }
        exportLink.href = exportUrl.toString();
      }

      function getHeaders() {
        return state.token ? { "x-panel-token": state.token } : {};
      }

      async function apiFetch(path, options = {}) {
        const response = await fetch(path, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...getHeaders(),
            ...(options.headers || {}),
          },
        });

        if (!response.ok) {
          let message = response.statusText;
          try {
            const payload = await response.json();
            message = payload.error || payload.message || message;
          } catch {}
          throw new Error(message);
        }

        return response.json();
      }

      function formatNumber(value) {
        return new Intl.NumberFormat().format(value);
      }

      function formatBytes(value) {
        if (typeof value !== "number" || Number.isNaN(value)) {
          return "n/a";
        }
        const units = ["B", "KB", "MB", "GB"];
        let current = value;
        let index = 0;
        while (current >= 1024 && index < units.length - 1) {
          current /= 1024;
          index += 1;
        }
        return current.toFixed(current >= 100 || index === 0 ? 0 : 1) + " " + units[index];
      }

      function formatDate(value) {
        if (!value) {
          return "n/a";
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function renderBadge(level, label) {
        return '<span class="badge ' + escapeHtml(level) + '">' + escapeHtml(label) + "</span>";
      }

      function listToTextareaValue(items) {
        return (items || []).join("\\n");
      }

      function textareaValueToList(value) {
        return value
          .split(/\\r?\\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }

      function renderHero(status) {
        const health = status.health;
        document.getElementById("heroStats").innerHTML = [
          ["Guilds", formatNumber(health.discord.guildCount)],
          ["Gateway ping", health.gateway.pingMs + " ms"],
          ["Event loop lag", health.eventLoop.lagMs.toFixed(1) + " ms"],
          ["Active voice guilds", formatNumber(health.music.activeGuildCount)],
        ].map(([label, value]) =>
          '<div class="statTile"><label>' + escapeHtml(label) + '</label><strong>' + escapeHtml(value) + '</strong></div>'
        ).join("");

        document.getElementById("sessionGrid").innerHTML = [
          ["Bot user", health.discord.loggedInUser || "Not logged in"],
          ["Gateway", health.gateway.status],
          ["PID", String(health.process.pid)],
          ["Node", health.process.nodeVersion],
        ].map(([label, value]) =>
          '<div class="miniCard"><label>' + escapeHtml(label) + '</label><strong>' + escapeHtml(value) + '</strong></div>'
        ).join("");

        document.getElementById("healthBadgeSlot").innerHTML = renderBadge(health.level, health.level.toUpperCase());
      }

      function renderOverview(status) {
        document.getElementById("lastUpdated").textContent = "Updated " + formatDate(status.generatedAt);
        document.getElementById("overviewCards").innerHTML = [
          ["Prefix", status.prefix],
          ["Commands", String(status.loadedCommands.length)],
          ["Cogs", status.enabledCogs.join(", ") || "None"],
          ["Recent log buffer", String(status.logs.length)],
          ["Heap used", formatBytes(status.health.process.heapUsedBytes)],
          ["Uptime", Math.round(status.health.process.uptimeSeconds) + " sec"],
          ["RSS memory", formatBytes(status.health.process.rssBytes)],
          ["Recent errors", String(status.health.recentErrors.count)],
        ].map(([label, value]) =>
          '<div class="miniCard"><label>' + escapeHtml(label) + '</label><strong>' + escapeHtml(value) + '</strong></div>'
        ).join("");
      }

      function renderHealth(status) {
        const signals = [
          ["Health level", renderBadge(status.health.level, status.health.level.toUpperCase())],
          ["Last error", (status.health.recentErrors.last && status.health.recentErrors.last.message) || "none"],
          ["Idle disconnect", Math.round(status.health.music.idleDisconnectMs / 1000) + " sec"],
          ["Polling", state.refreshSeconds + " sec"],
        ];

        document.getElementById("healthSignals").innerHTML = signals
          .map(([label, value]) =>
            '<div class="miniCard"><label>' + escapeHtml(label) + '</label><div>' + value + '</div></div>'
          ).join("");
      }

      function renderGuilds(status) {
        const guilds = status.guilds || [];
        document.getElementById("guildCountLabel").textContent = String(guilds.length);
        const list = document.getElementById("guildList");
        if (!guilds.length) {
          list.innerHTML = '<div class="empty">No guilds connected.</div>';
          return;
        }

        list.innerHTML = guilds.map((guild) => {
          const activeClass = guild.id === state.selectedGuildId ? " active" : "";
          return '<button class="guildButton' + activeClass + '" data-guild-id="' + escapeHtml(guild.id) + '">' +
            '<strong>' + escapeHtml(guild.name) + '</strong>' +
            '<span>' + escapeHtml(guild.memberCount + " members") + '</span>' +
            '<div class="guildMeta">' +
              '<span class="guildPill">' + escapeHtml(guild.music.connectionStatus) + '</span>' +
              '<span class="guildPill">' + escapeHtml(guild.music.playbackStatus) + '</span>' +
            '</div>' +
          '</button>';
        }).join("");

        for (const button of list.querySelectorAll("[data-guild-id]")) {
          button.addEventListener("click", () => {
            selectGuild(button.getAttribute("data-guild-id"));
          });
        }
      }

      function renderLogs(status) {
        const logs = (status.logs || []).slice(-80);
        const terminal = document.getElementById("terminalOutput");
        terminal.value = logs.length
          ? logs.map((line) => "[" + new Date(line.at).toLocaleTimeString() + "] [" + line.level.toUpperCase() + "] " + line.message).join("\\n")
          : "No buffered logs yet.";
        terminal.scrollTop = terminal.scrollHeight;
      }

      function renderRefreshButtons() {
        for (const button of document.querySelectorAll("[data-interval-seconds]")) {
          const seconds = Number(button.getAttribute("data-interval-seconds"));
          button.classList.toggle("active", seconds === state.refreshSeconds);
        }
      }

      function startAutoRefresh() {
        if (state.refreshTimer) {
          clearInterval(state.refreshTimer);
        }
        state.refreshTimer = setInterval(() => {
          loadStatus().catch(() => {
            // Keep polling alive even if a single request fails.
          });
        }, state.refreshSeconds * 1000);
      }

      function setRefreshSeconds(seconds) {
        state.refreshSeconds = seconds;
        renderRefreshButtons();
        startAutoRefresh();
        if (state.status) {
          renderHealth(state.status);
        }
      }

      function renderGuildSummaryCards(detail) {
        return [
          ["Connection", detail.musicState.connectionStatus],
          ["Playback", detail.musicState.playbackStatus],
          ["Queue length", String(detail.musicState.queue.length)],
          ["Members", String(detail.summary.memberCount ?? "n/a")],
        ].map(([label, value]) =>
          '<div class="miniCard"><label>' + escapeHtml(label) + '</label><strong>' + escapeHtml(value) + '</strong></div>'
        ).join("");
      }

      function renderGuildOverviewTab(detail) {
        const currentTrack = detail.musicState.current
          ? '<div class="listItem"><div class="muted">Current track</div><code>' + escapeHtml(detail.musicState.current.title) + '</code></div>'
          : '<div class="empty">Nothing is currently playing in this guild.</div>';

        return [
          '<div class="stack">',
          '  <div class="panel" style="box-shadow:none;">',
          '    <div class="panelHeader"><h2>Runtime overview</h2></div>',
          '    <div class="panelBody">',
          '      <div class="list">',
          '        <div class="listItem"><div class="muted">Voice summary</div><code>' + escapeHtml(detail.voiceSummary) + '</code></div>',
          '        <div class="listItem"><div class="muted">Last stop reason</div><code>' + escapeHtml(detail.musicState.lastStopReason || "none") + '</code></div>',
          '        <div class="listItem"><div class="muted">Text channel</div><code>' + escapeHtml(detail.musicState.textChannelId || "none") + '</code></div>',
          '        <div class="listItem"><div class="muted">Voice channel</div><code>' + escapeHtml(detail.musicState.voiceChannelId || "none") + '</code></div>',
                   currentTrack,
          '      </div>',
          '    </div>',
          '  </div>',
          '</div>',
        ].join("");
      }

      function renderGuildConfigTab(detail) {
        const config = detail.config.merged;
        return [
          '<div class="panel" style="box-shadow:none;">',
          '  <div class="panelHeader"><h2>Guild configuration</h2></div>',
          '  <div class="panelBody">',
          '    <form id="guildConfigForm">',
          '      <div class="field">',
          '        <label for="adminsField">Admin user IDs</label>',
          '        <textarea id="adminsField">' + escapeHtml(listToTextareaValue(config.admins)) + '</textarea>',
          '      </div>',
          '      <div class="field">',
          '        <label for="commandChannelsField">Command channel IDs</label>',
          '        <textarea id="commandChannelsField">' + escapeHtml(listToTextareaValue(config.commandChannels)) + '</textarea>',
          '      </div>',
          '      <div class="field">',
          '        <label for="channelWhitelistField">Channel whitelist IDs</label>',
          '        <textarea id="channelWhitelistField">' + escapeHtml(listToTextareaValue(config.channelWhitelist)) + '</textarea>',
          '      </div>',
          '      <div class="field">',
          '        <label for="blockedUsersField">Blocked user IDs</label>',
          '        <textarea id="blockedUsersField">' + escapeHtml(listToTextareaValue(config.blockedUsers)) + '</textarea>',
          '      </div>',
          '      <div class="field">',
          '        <label for="pingRoleIdField">Ping role ID</label>',
          '        <input id="pingRoleIdField" value="' + escapeHtml(config.pingRoleId || "") + '" placeholder="Leave blank for none" />',
          '      </div>',
          '      <div class="actions">',
          '        <button class="primary" type="submit">Save guild config</button>',
          '        <button class="secondary" type="button" id="reloadGuildButton">Reload guild</button>',
          '      </div>',
          '      <div class="message" id="guildConfigMessage"></div>',
          '    </form>',
          '  </div>',
          '</div>',
        ].join("");
      }

      function renderGuildDiagnosticsTab(detail) {
        const diagnosticsText = detail.diagnostics.length
          ? detail.diagnostics.slice().reverse().join("\\n")
          : "No diagnostics recorded for this guild.";

        return [
          '<div class="panel" style="box-shadow:none;">',
          '  <div class="panelHeader"><h2>Voice + diagnostics</h2></div>',
          '  <div class="panelBody"><div class="stack">',
          '    <div class="listItem"><div class="muted">Voice summary</div><code>' + escapeHtml(detail.voiceSummary) + '</code></div>',
          '    <textarea class="terminalBox diagnosticTerminal" readonly spellcheck="false">' + escapeHtml(diagnosticsText) + '</textarea>',
          '  </div></div>',
          '</div>',
        ].join("");
      }

      function renderGuildChannelsTab(detail) {
        const channelsHtml = detail.channels.length
          ? detail.channels.map((channel) =>
              '<div class="listItem"><strong>' + escapeHtml(channel.name) + '</strong><br /><span class="muted">' + escapeHtml(channel.type) + ' - ' + escapeHtml(channel.id) + '</span></div>'
            ).join("")
          : '<div class="empty">No cached channels.</div>';

        return [
          '<div class="panel" style="box-shadow:none;">',
          '  <div class="panelHeader"><h2>Channels</h2></div>',
          '  <div class="panelBody"><div class="list">',
                   channelsHtml,
          '  </div></div>',
          '</div>',
        ].join("");
      }

      function renderGuildRolesTab(detail) {
        const rolesHtml = detail.roles.length
          ? detail.roles.slice(0, 30).map((role) =>
              '<div class="listItem"><strong>' + escapeHtml(role.name) + '</strong><br /><span class="muted">' + escapeHtml(role.id) + ' - ' + escapeHtml(role.color) + '</span></div>'
            ).join("")
          : '<div class="empty">No cached roles.</div>';

        return [
          '<div class="panel" style="box-shadow:none;">',
          '  <div class="panelHeader"><h2>Roles</h2></div>',
          '  <div class="panelBody"><div class="list">',
                   rolesHtml,
          '  </div></div>',
          '</div>',
        ].join("");
      }

      function renderGuildTabContent(detail) {
        if (state.selectedGuildTab === "config") {
          return renderGuildConfigTab(detail);
        }
        if (state.selectedGuildTab === "diagnostics") {
          return renderGuildDiagnosticsTab(detail);
        }
        if (state.selectedGuildTab === "channels") {
          return renderGuildChannelsTab(detail);
        }
        if (state.selectedGuildTab === "roles") {
          return renderGuildRolesTab(detail);
        }
        return renderGuildOverviewTab(detail);
      }

      function renderGuildDetail(detail) {
        const root = document.getElementById("guildDetailRoot");
        const summary = detail.summary;
        document.getElementById("guildTitle").textContent = summary.name;
        document.getElementById("guildSubtitle").textContent = summary.id + " - joined " + formatDate(summary.joinedAt);

        const tabs = [
          ["overview", "Overview"],
          ["config", "Config"],
          ["diagnostics", "Diagnostics"],
          ["channels", "Channels"],
          ["roles", "Roles"],
        ];

        root.innerHTML = [
          '<div class="summaryStrip">',
                   renderGuildSummaryCards(detail),
          '</div>',
          '<div class="tabBar" id="guildTabBar">',
                   tabs.map(([tabId, label]) => {
                     const activeClass = state.selectedGuildTab === tabId ? " active" : "";
                     return '<button class="tabButton' + activeClass + '" type="button" data-guild-tab="' + escapeHtml(tabId) + '">' + escapeHtml(label) + '</button>';
                   }).join(""),
          '</div>',
          '<div class="tabPanel" id="guildTabPanel">',
                   renderGuildTabContent(detail),
          '</div>',
        ].join("");

        for (const button of root.querySelectorAll("[data-guild-tab]")) {
          button.addEventListener("click", () => {
            state.selectedGuildTab = button.getAttribute("data-guild-tab") || "overview";
            renderGuildDetail(detail);
          });
        }

        const form = document.getElementById("guildConfigForm");
        if (form) {
          form.addEventListener("submit", saveGuildConfig);
        }

        const reloadGuildButton = document.getElementById("reloadGuildButton");
        if (reloadGuildButton) {
          reloadGuildButton.addEventListener("click", () => selectGuild(summary.id, true));
        }
      }

      async function saveGuildConfig(event) {
        event.preventDefault();
        if (!state.selectedGuildId) {
          return;
        }
        const message = document.getElementById("guildConfigMessage");
        message.className = "message";
        message.textContent = "Saving...";

        try {
          await apiFetch("/api/guilds/" + encodeURIComponent(state.selectedGuildId) + "/config", {
            method: "PUT",
            body: JSON.stringify({
              admins: textareaValueToList(document.getElementById("adminsField").value),
              commandChannels: textareaValueToList(document.getElementById("commandChannelsField").value),
              channelWhitelist: textareaValueToList(document.getElementById("channelWhitelistField").value),
              blockedUsers: textareaValueToList(document.getElementById("blockedUsersField").value),
              pingRoleId: document.getElementById("pingRoleIdField").value.trim() || null,
            }),
          });
          message.className = "message success";
          message.textContent = "Saved.";
          await loadStatus();
          await selectGuild(state.selectedGuildId, true);
        } catch (error) {
          message.className = "message error";
          message.textContent = error.message;
        }
      }

      async function selectGuild(guildId, forceReload = false) {
        if (!guildId) {
          return;
        }
        if (state.selectedGuildId === guildId && state.selectedGuildDetail && !forceReload) {
          renderGuildDetail(state.selectedGuildDetail);
          return;
        }

        state.selectedGuildId = guildId;
        renderGuilds(state.status);
        document.getElementById("guildDetailRoot").innerHTML = '<div class="empty">Loading guild details...</div>';

        try {
          const detail = await apiFetch("/api/guilds/" + encodeURIComponent(guildId));
          state.selectedGuildDetail = detail;
          renderGuildDetail(detail);
        } catch (error) {
          document.getElementById("guildDetailRoot").innerHTML = '<div class="empty">Failed to load guild: ' + escapeHtml(error.message) + '</div>';
        }
      }

      async function loadStatus() {
        const status = await apiFetch("/api/status");
        state.status = status;
        renderHero(status);
        renderOverview(status);
        renderHealth(status);
        renderGuilds(status);
        renderLogs(status);

        if (!state.selectedGuildId && status.guilds.length) {
          await selectGuild(status.guilds[0].id);
        } else if (state.selectedGuildId) {
          const stillExists = status.guilds.some((guild) => guild.id === state.selectedGuildId);
          if (stillExists) {
            renderGuilds(status);
          } else {
            state.selectedGuildId = null;
            state.selectedGuildDetail = null;
            document.getElementById("guildDetailRoot").innerHTML = '<div class="empty">The previously selected guild is no longer connected.</div>';
          }
        }
      }

      refreshButton.addEventListener("click", () => {
        loadStatus().catch((error) => {
          document.getElementById("guildDetailRoot").innerHTML = '<div class="empty">Refresh failed: ' + escapeHtml(error.message) + '</div>';
        });
      });

      if (themeToggle) {
        themeToggle.addEventListener("click", () => {
          toggleTheme();
        });
      }

      for (const button of document.querySelectorAll("[data-interval-seconds]")) {
        button.addEventListener("click", () => {
          const seconds = Number(button.getAttribute("data-interval-seconds"));
          if (seconds === 2 || seconds === 5 || seconds === 10) {
            setRefreshSeconds(seconds);
          }
        });
      }

      setToken(new URLSearchParams(window.location.search).get("token") || "");
      applyTheme(localStorage.getItem("glizzbot-panel-theme") || "dark");
      renderRefreshButtons();
      startAutoRefresh();
      loadStatus().catch((error) => {
        document.getElementById("guildDetailRoot").innerHTML = '<div class="empty">Failed to load panel data: ' + escapeHtml(error.message) + '</div>';
      });
    </script>
  </body>
</html>`;
}

export function startWebPanel(bot: GlizzBot, port: number, token: string): void {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(authMiddleware(token));

  app.get("/", (_req, res) => {
    res.type("html").send(buildPanelHtml(bot.config));
  });

  app.get("/api/status", (_req, res) => {
    res.json(buildStatusPayload(bot));
  });

  app.get("/api/health", (_req, res) => {
    res.json(getHealthSignals(bot));
  });

  app.get("/api/guilds", (_req, res) => {
    const guilds = bot.guilds.cache
      .map((guild) => getGuildSummary(bot, guild.id))
      .filter((guild): guild is NonNullable<typeof guild> => Boolean(guild))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ guilds });
  });

  app.get("/api/guilds/:guildId", (req, res) => {
    const detail = getGuildDetail(bot, req.params.guildId);
    if (!detail) {
      res.status(404).json({ error: "guild not found" });
      return;
    }
    res.json(detail);
  });

  app.put("/api/guilds/:guildId/config", (req, res) => {
    const guild = bot.guilds.cache.get(req.params.guildId);
    if (!guild) {
      res.status(404).json({ error: "guild not found" });
      return;
    }

    try {
      const patch = validateGuildConfigPatch(req.body as GuildConfigPatchPayload);
      const nextConfig = bot.configStore.upsertGuildConfig(bot.config, guild.id, patch);
      Object.assign(bot.config, nextConfig);
      bot.logger.info(`Web panel updated guild config for ${guild.name} (${guild.id})`);
      res.json({
        guildId: guild.id,
        config: bot.configStore.getGuildConfig(bot.config, guild.id),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/export", (_req, res) => {
    res.json(buildExportPayload(bot));
  });

  app.listen(port, () => {
    bot.logger.info(`Web panel listening on http://localhost:${port}`);
  });
}
