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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
