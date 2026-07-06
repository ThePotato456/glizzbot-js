import fs from "node:fs";
import type { RuntimePaths } from "./types.js";
import { LogBuffer } from "./services/logBuffer.js";

export class AppLogger {
  readonly buffer = new LogBuffer();

  constructor(private readonly paths: RuntimePaths, private readonly debugEnabled: boolean) {
    fs.mkdirSync(this.paths.logsDir, { recursive: true });
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      this.write("debug", message);
    }
  }

  private write(level: "info" | "warn" | "error" | "debug", message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    this.buffer.push(level, message);
    console.log(line);
    fs.appendFileSync(this.paths.discordLogFile, `${line}\n`);
    fs.appendFileSync(this.paths.sessionLogFile, `${line}\n`);
  }
}
