import { spawn } from "node:child_process";
import type { QueueSourceType, RuntimePaths } from "../types.js";

interface YtDlpMetadata {
  id?: string;
  title?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  extractor?: string;
  entries?: Array<YtDlpMetadata | null>;
}

export interface ResolvedMediaResult {
  title: string;
  input: string;
  sourceType: QueueSourceType;
  durationSeconds?: number;
  streamUrl: string;
  webpageUrl?: string;
  extractor?: string;
  requestedQuery?: string;
}

export type YtDlpRunner = (args: string[]) => Promise<string>;

export class YtDlpService {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly runner: YtDlpRunner | null = null,
  ) {}

  async resolve(input: string, sourceType: QueueSourceType): Promise<ResolvedMediaResult> {
    const query = sourceType === "search" ? `ytsearch1:${input}` : input;
    const metadata = await this.fetchMetadata(query);
    const entry = metadata.entries?.find((candidate) => Boolean(candidate)) ?? metadata;
    if (!entry.url) {
      throw new Error("yt-dlp did not return a playable stream URL.");
    }

    return {
      title: entry.title ?? input,
      input,
      sourceType,
      durationSeconds: entry.duration,
      streamUrl: entry.url,
      webpageUrl: entry.webpage_url ?? entry.original_url ?? input,
      extractor: entry.extractor,
      requestedQuery: sourceType === "search" ? input : undefined,
    };
  }

  private async fetchMetadata(input: string): Promise<YtDlpMetadata> {
    const stdout = await this.runYtDlp([
      "--dump-single-json",
      "--no-playlist",
      "-f", "bestaudio/best",
      input,
    ]);
    return JSON.parse(stdout) as YtDlpMetadata;
  }

  private runYtDlp(args: string[]): Promise<string> {
    if (this.runner) {
      return this.runner(args);
    }
    return new Promise((resolve, reject) => {
      const child = spawn("yt-dlp", args, {
        cwd: this.paths.root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      });
    });
  }
}
