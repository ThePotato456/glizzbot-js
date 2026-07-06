import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QueueItem, RuntimePaths } from "../types.js";
import { formatDuration } from "../utils/format.js";

const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_USER_ID_LENGTH = 128;

const CREATE_SONG_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS song_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_title TEXT NOT NULL,
  song_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  duration TEXT NOT NULL,
  datetime INTEGER NOT NULL
);
`;

type SongHistoryRuntimePaths = {
  databaseFile: RuntimePaths["databaseFile"];
  legacyDatabaseFile?: string | null;
};

export interface SongHistoryRow {
  song_title: string;
  song_url: string;
  user_id: string;
  duration: string;
  datetime: number;
}

export class SongHistoryRepository {
  private readonly database: DatabaseSync;
  private readonly insertSongStatement: ReturnType<DatabaseSync["prepare"]>;

  constructor(private readonly paths: SongHistoryRuntimePaths) {
    this.ensureDatabaseFile();
    this.database = new DatabaseSync(this.paths.databaseFile);
    this.migrate();
    this.insertSongStatement = this.database.prepare(`
      INSERT INTO song_history (song_title, song_url, user_id, duration, datetime)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  recordTrack(track: Pick<QueueItem, "title" | "url" | "requestedBy" | "durationSeconds">): void {
    this.insertSongStatement.run(
      this.normalizeText(track.title, "Unknown Track", MAX_TITLE_LENGTH),
      this.normalizeText(track.url, "", MAX_URL_LENGTH),
      this.normalizeText(track.requestedBy, "unknown", MAX_USER_ID_LENGTH),
      formatDuration(track.durationSeconds),
      Math.floor(Date.now() / 1000),
    );
  }

  countSongs(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM song_history").get() as { count: number };
    return row.count;
  }

  getLatestSong(): { song_title: string; song_url: string; user_id: string; duration: string } | null {
    const row = this.database.prepare(`
      SELECT song_title, song_url, user_id, duration
      FROM song_history
      ORDER BY id DESC
      LIMIT 1
    `).get() as { song_title: string; song_url: string; user_id: string; duration: string } | undefined;
    return row ?? null;
  }

  getRandomSongs(limit: number, userId?: string): SongHistoryRow[] {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit < 1) {
      return [];
    }

    if (userId && userId.trim()) {
      return this.database.prepare(`
        SELECT song_title, song_url, user_id, duration, datetime
        FROM song_history
        WHERE user_id = ?
        ORDER BY RANDOM()
        LIMIT ?
      `).all(userId.trim(), normalizedLimit) as unknown as SongHistoryRow[];
    }

    return this.database.prepare(`
      SELECT song_title, song_url, user_id, duration, datetime
      FROM song_history
      ORDER BY RANDOM()
      LIMIT ?
    `).all(normalizedLimit) as unknown as SongHistoryRow[];
  }

  close(): void {
    this.database.close();
  }

  private ensureDatabaseFile(): void {
    fs.mkdirSync(path.dirname(this.paths.databaseFile), { recursive: true });

    if (fs.existsSync(this.paths.databaseFile)) {
      return;
    }

    if (this.paths.legacyDatabaseFile && fs.existsSync(this.paths.legacyDatabaseFile) && fs.lstatSync(this.paths.legacyDatabaseFile).isFile()) {
      fs.copyFileSync(this.paths.legacyDatabaseFile, this.paths.databaseFile);
      return;
    }

    const handle = fs.openSync(this.paths.databaseFile, "a");
    fs.closeSync(handle);
  }

  private migrate(): void {
    this.database.exec(CREATE_SONG_HISTORY_TABLE);

    const columns = this.database.prepare("PRAGMA table_info(song_history)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (columnNames.has("played_by") && !columnNames.has("user_id")) {
      this.database.exec("ALTER TABLE song_history RENAME COLUMN played_by TO user_id");
    }
  }

  private normalizeText(value: string | undefined, fallback: string, maxLength: number): string {
    const normalized = String(value ?? fallback).trim();
    if (!normalized) {
      return fallback;
    }
    return normalized.slice(0, maxLength);
  }
}
