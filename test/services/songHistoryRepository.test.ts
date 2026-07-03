import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SongHistoryRepository } from "../../src/services/songHistoryRepository.js";
import { createTestRuntimePaths } from "../helpers/testRuntimePaths.js";

function resetRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}

test("song history repository imports the legacy database when the local database is missing", () => {
  const root = path.resolve("test-tmp", "song-history-import");
  resetRoot(root);
  const paths = createTestRuntimePaths(root);
  fs.mkdirSync(path.dirname(paths.legacyDatabaseFile), { recursive: true });
  fs.copyFileSync(path.resolve("..", "GlizzBot", "config", "database.db"), paths.legacyDatabaseFile);

  const repository = new SongHistoryRepository(paths);
  const count = repository.countSongs();
  repository.close();

  assert.ok(fs.existsSync(paths.databaseFile));
  assert.ok(count > 0);
});

test("song history repository records tracks using the legacy schema", () => {
  const root = path.resolve("test-tmp", "song-history-write");
  resetRoot(root);
  const paths = createTestRuntimePaths(root);

  const repository = new SongHistoryRepository(paths);
  repository.recordTrack({
    title: "Database Test Track",
    url: "https://example.com/watch?v=dbtest",
    requestedBy: "user-123",
    durationSeconds: 245,
  });
  const latest = repository.getLatestSong();
  repository.close();

  assert.ok(latest);
  assert.equal(latest?.song_title, "Database Test Track");
  assert.equal(latest?.song_url, "https://example.com/watch?v=dbtest");
  assert.equal(latest?.user_id, "user-123");
  assert.equal(latest?.duration, "04:05");
});

test("song history repository normalizes oversized or blank values before writing", () => {
  const root = path.resolve("test-tmp", "song-history-normalize");
  resetRoot(root);
  const paths = createTestRuntimePaths(root);

  const repository = new SongHistoryRepository(paths);
  repository.recordTrack({
    title: " ".repeat(5),
    url: `https://example.com/${"x".repeat(3000)}`,
    requestedBy: "",
    durationSeconds: undefined,
  });
  const latest = repository.getLatestSong();
  repository.close();

  assert.ok(latest);
  assert.equal(latest?.song_title, "Unknown Track");
  assert.equal(latest?.user_id, "unknown");
  assert.equal(latest?.duration, "unknown");
  assert.ok((latest?.song_url.length ?? 0) <= 2048);
});

test("song history repository can sample random songs for a specific user", () => {
  const root = path.resolve("test-tmp", "song-history-random");
  resetRoot(root);
  const paths = createTestRuntimePaths(root);

  const repository = new SongHistoryRepository(paths);
  repository.recordTrack({
    title: "User One Track",
    url: "https://example.com/watch?v=one",
    requestedBy: "user-1",
    durationSeconds: 60,
  });
  repository.recordTrack({
    title: "User Two Track",
    url: "https://example.com/watch?v=two",
    requestedBy: "user-2",
    durationSeconds: 70,
  });

  const songs = repository.getRandomSongs(5, "user-1");
  repository.close();

  assert.equal(songs.length, 1);
  assert.equal(songs[0]?.song_title, "User One Track");
  assert.equal(songs[0]?.user_id, "user-1");
});
