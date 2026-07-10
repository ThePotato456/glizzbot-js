import fs from "node:fs";
import path from "node:path";

export interface RuntimeVersionInfo {
  gitCommit: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
  displayVersion: string;
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function resolveGitDir(root: string): string | null {
  const dotGitPath = path.join(root, ".git");
  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const pointer = safeReadFile(dotGitPath)?.trim();
  if (!pointer?.toLowerCase().startsWith("gitdir:")) {
    return null;
  }

  const relativeGitDir = pointer.slice("gitdir:".length).trim();
  if (!relativeGitDir) {
    return null;
  }

  return path.resolve(root, relativeGitDir);
}

function readPackedRef(gitDir: string, ref: string): string | null {
  const packedRefs = safeReadFile(path.join(gitDir, "packed-refs"));
  if (!packedRefs) {
    return null;
  }

  for (const line of packedRefs.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) {
      continue;
    }

    const [commit, candidateRef] = trimmed.split(" ", 2);
    if (candidateRef === ref && commit) {
      return commit;
    }
  }

  return null;
}

function readGitHead(root: string): { gitCommit: string | null; gitBranch: string | null } {
  const gitDir = resolveGitDir(root);
  if (!gitDir) {
    return {
      gitCommit: null,
      gitBranch: null,
    };
  }

  const head = safeReadFile(path.join(gitDir, "HEAD"))?.trim();
  if (!head) {
    return {
      gitCommit: null,
      gitBranch: null,
    };
  }

  if (!head.startsWith("ref:")) {
    return {
      gitCommit: head || null,
      gitBranch: null,
    };
  }

  const ref = head.slice("ref:".length).trim();
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  const looseRefPath = path.join(gitDir, ...ref.split("/"));
  const looseCommit = safeReadFile(looseRefPath)?.trim();
  const packedCommit = readPackedRef(gitDir, ref);

  return {
    gitCommit: looseCommit || packedCommit || null,
    gitBranch: branch || null,
  };
}

export function readRuntimeVersion(root: string): RuntimeVersionInfo {
  const { gitCommit, gitBranch } = readGitHead(root);
  const gitCommitShort = gitCommit ? gitCommit.slice(0, 7) : null;
  const displayVersion = gitCommitShort ?? "no-git";

  return {
    gitCommit,
    gitCommitShort,
    gitBranch,
    displayVersion,
  };
}
