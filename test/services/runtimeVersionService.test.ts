import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readRuntimeVersion } from "../../src/services/runtimeVersionService.js";

function createTempRoot(name: string): string {
  const root = path.resolve("test-tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("readRuntimeVersion reads loose git head refs", () => {
  const root = createTempRoot("runtime-version-loose");
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), "abcdef1234567890\n");

  const version = readRuntimeVersion(root);

  assert.equal(version.gitCommit, "abcdef1234567890");
  assert.equal(version.gitCommitShort, "abcdef1");
  assert.equal(version.gitBranch, "main");
  assert.equal(version.displayVersion, "abcdef1");
});

test("readRuntimeVersion resolves gitdir pointers and packed refs", () => {
  const root = createTempRoot("runtime-version-worktree");
  const gitDir = path.join(root, ".git-data");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(root, ".git"), "gitdir: .git-data\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/release\n");
  fs.writeFileSync(path.join(gitDir, "packed-refs"), "# pack-refs with: peeled fully-peeled sorted\n1234567890abcdef refs/heads/release\n");

  const version = readRuntimeVersion(root);

  assert.equal(version.gitCommit, "1234567890abcdef");
  assert.equal(version.gitCommitShort, "1234567");
  assert.equal(version.gitBranch, "release");
  assert.equal(version.displayVersion, "1234567");
});
