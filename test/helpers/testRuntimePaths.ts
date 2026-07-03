import path from "node:path";
import type { RuntimePaths } from "../../src/types.js";

export function createTestRuntimePaths(root = path.resolve("test-tmp")): RuntimePaths {
  return {
    root,
    configDir: path.join(root, "config"),
    configFile: path.join(root, "config", "config.json"),
    databaseFile: path.join(root, "config", "database.db"),
    downloadsDir: path.join(root, "downloads"),
    tempDir: path.join(root, "temp"),
    ytdlpTempDir: path.join(root, "temp", "ytdlp"),
    audioDir: path.join(root, "audio"),
    recordingsDir: path.join(root, "recordings"),
    soundsManifestFile: path.join(root, "audio", "sounds.json"),
    discordLogFile: path.join(root, "discord.log"),
  };
}
