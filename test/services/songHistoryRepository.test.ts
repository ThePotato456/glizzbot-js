import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SongHistoryRepository } from "../../src/services/songHistoryRepository.js";
import { createTestRuntimePaths, createUniqueTestRoot } from "../helpers/testRuntimePaths.js";

test("song history repository imports the legacy database when the local database is missing", () => {
  const root = createUniqueTestRoot("song-history-import");
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
  const root = createUniqueTestRoot("song-history-write");
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
  const root = createUniqueTestRoot("song-history-normalize");
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
  const root = createUniqueTestRoot("song-history-random");
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

test("song history repository prefers distinct songs in random samples", () => {
  const root = createUniqueTestRoot("song-history-random-distinct");
  const paths = createTestRuntimePaths(root);

  const repository = new SongHistoryRepository(paths);
  for (let index = 0; index < 4; index += 1) {
    repository.recordTrack({
      title: `Repeated Track ${index}`,
      url: "https://example.com/watch?v=repeated",
      requestedBy: "user-1",
      durationSeconds: 60,
    });
  }
  repository.recordTrack({
    title: "Different Track",
    url: "https://example.com/watch?v=different",
    requestedBy: "user-1",
    durationSeconds: 70,
  });

  const songs = repository.getRandomSongs(2, "user-1");
  repository.close();

  assert.equal(songs.length, 2);
  assert.equal(new Set(songs.map((song) => song.song_url)).size, 2);
});
