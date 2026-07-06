import fs from "node:fs";
import process from "node:process";
import { buildRuntimePaths } from "./runtimePaths.js";
import { ConfigStore } from "./config.js";
import { GlizzBot } from "./bot.js";

async function main(): Promise<void> {
  const root = process.cwd();
  const paths = buildRuntimePaths(root);
  const configStore = new ConfigStore(paths);
  const config = configStore.load();
  const bot = new GlizzBot(config, paths);
  await bot.bootstrap();
}

function appendStartupFailureLog(root: string, error: unknown): void {
  const paths = buildRuntimePaths(root);
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  const line = `[${new Date().toISOString()}] [ERROR] startup failure: ${details}`;
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.appendFileSync(paths.discordLogFile, `${line}\n`);
  fs.appendFileSync(paths.sessionLogFile, `${line}\n`);
}

main().catch((error) => {
  appendStartupFailureLog(process.cwd(), error);
  console.error(error);
  process.exitCode = 1;
});
