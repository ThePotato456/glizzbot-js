import path from "node:path";
import type { RuntimePaths } from "./types.js";

function formatSessionLogTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}.txt`;
}

export function buildRuntimePaths(root: string): RuntimePaths {
  const logsDir = path.join(root, "logs");
  return {
    root,
    configDir: path.join(root, "config"),
    configFile: path.join(root, "config", "config.json"),
    databaseFile: path.join(root, "config", "database.db"),
    logsDir,
    sessionLogFile: path.join(logsDir, formatSessionLogTimestamp(new Date())),
    downloadsDir: path.join(root, "downloads"),
    tempDir: path.join(root, "temp"),
    ytdlpTempDir: path.join(root, "temp", "ytdlp"),
    audioDir: path.join(root, "audio"),
    recordingsDir: path.join(root, "recordings"),
    soundsManifestFile: path.join(root, "audio", "sounds.json"),
    discordLogFile: path.join(root, "discord.log"),
  };
}
