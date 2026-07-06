import test from "node:test";
import assert from "node:assert/strict";
import { MusicResolverService } from "../../src/services/musicResolverService.js";
import { createTestRuntimePaths } from "../helpers/testRuntimePaths.js";

test("resolveInput prepares a play query through yt-dlp", async () => {
  const paths = createTestRuntimePaths();
  const resolver = new MusicResolverService(paths, async () => JSON.stringify({
    title: "Test Query Result",
    duration: 123,
    url: "https://media.example/stream",
    webpage_url: "https://example.com/watch?v=123",
    extractor: "youtube",
    http_headers: {
      "User-Agent": "Resolver Test",
      Referer: "https://example.com/",
    },
  }));

  const result = await resolver.resolveInput("my song query", "user-1");

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.title, "Test Query Result");
  assert.equal(item.streamUrl, "https://media.example/stream");
  assert.equal(item.streamHeaders?.["User-Agent"], "Resolver Test");
  assert.equal(item.streamHeaders?.Referer, "https://example.com/");
  assert.equal(item.durationSeconds, 123);
  assert.equal(item.sourceType, "search");
  assert.match(result.summary, /Resolved with yt-dlp/);
});

test("resolveInput falls back to deferred queue item when yt-dlp fails", async () => {
  const paths = createTestRuntimePaths();
  const resolver = new MusicResolverService(paths, async () => {
    throw new Error("yt-dlp unavailable");
  });

  const result = await resolver.resolveInput("broken query", "user-1");

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.isResolved, false);
  assert.equal(item.sourceType, "search");
  assert.match(item.resolverNote ?? "", /yt-dlp prepare failed/);
});

test("resolveQueueItem refreshes a deferred item into a stream url", async () => {
  const paths = createTestRuntimePaths();
  const resolver = new MusicResolverService(paths, async () => JSON.stringify({
    title: "Resolved Later",
    duration: 200,
    url: "https://media.example/later",
    webpage_url: "https://example.com/watch?v=later",
    extractor: "youtube",
    http_headers: {
      "User-Agent": "Retry Test",
    },
  }));

  const resolved = await resolver.resolveQueueItem({
    id: "q1",
    title: "placeholder",
    url: "placeholder input",
    requestedBy: "user-1",
    isResolved: false,
    sourceType: "search",
    addedAt: Date.now(),
  });

  assert.equal(resolved.isResolved, true);
  assert.equal(resolved.title, "Resolved Later");
  assert.equal(resolved.streamUrl, "https://media.example/later");
  assert.equal(resolved.streamHeaders?.["User-Agent"], "Retry Test");
  assert.match(resolved.resolverNote ?? "", /Resolved stream with yt-dlp/);
});

test("resolveQueueItem returns an already-resolved item without calling yt-dlp again", async () => {
  const paths = createTestRuntimePaths();
  let calls = 0;
  const resolver = new MusicResolverService(paths, async () => {
    calls += 1;
    throw new Error("runner should not be called");
  });

  const resolved = await resolver.resolveQueueItem({
    id: "q1",
    title: "Already Ready",
    url: "https://example.com/watch?v=ready",
    requestedBy: "user-1",
    isResolved: true,
    sourceType: "url",
    streamUrl: "https://media.example/already-ready",
    addedAt: Date.now(),
  });

  assert.equal(calls, 0);
  assert.equal(resolved.streamUrl, "https://media.example/already-ready");
  assert.equal(resolved.title, "Already Ready");
});

test("resolveQueueItem keeps items unresolved when yt-dlp fails so they can retry later", async () => {
  const paths = createTestRuntimePaths();
  const resolver = new MusicResolverService(paths, async () => {
    throw new Error("temporary extractor failure");
  });

  const resolved = await resolver.resolveQueueItem({
    id: "q1",
    title: "Retry Me",
    url: "retry input",
    requestedBy: "user-1",
    isResolved: false,
    sourceType: "search",
    addedAt: Date.now(),
  });

  assert.equal(resolved.isResolved, false);
  assert.equal(resolved.streamUrl, undefined);
  assert.match(resolved.resolverNote ?? "", /temporary extractor failure/);
});

test("resolveInput expands YouTube playlist URLs into deferred queue items", async () => {
  const paths = createTestRuntimePaths();
  const resolver = new MusicResolverService(paths, async () => JSON.stringify({
    title: "Test Playlist",
    extractor: "youtube:tab",
    entries: [
      {
        id: "abc123",
        title: "Playlist Track One",
        ie_key: "Youtube",
      },
      {
        id: "def456",
        title: "Playlist Track Two",
        ie_key: "Youtube",
      },
    ],
  }));

  const result = await resolver.resolveInput("https://www.youtube.com/watch?v=abc123&list=playlist42", "user-1");

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.title, "Playlist Track One");
  assert.equal(result.items[0]?.url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(result.items[0]?.isResolved, false);
  assert.equal(result.items[0]?.sourceType, "url");
  assert.equal(result.items[1]?.title, "Playlist Track Two");
  assert.match(result.summary, /Queued 2 track\(s\) from playlist/i);
});

test("resolveInput reports playlist expansion failures clearly", async () => {
  const paths = createTestRuntimePaths();
  const resolver = new MusicResolverService(paths, async () => {
    throw new Error("playlist metadata unavailable");
  });

  const result = await resolver.resolveInput("https://www.youtube.com/watch?v=abc123&list=playlist42", "user-1");

  assert.equal(result.items.length, 0);
  assert.match(result.summary, /Failed to expand playlist with yt-dlp/i);
});
