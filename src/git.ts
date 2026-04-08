import { execSync } from "node:child_process";

export interface GitState {
  sha: string | null;
  branch: string | null;
  isRepo: boolean;
  isDirty: boolean;
}

export interface GitDiff {
  changedFiles: string[];     // modified + added
  deletedFiles: string[];     // removed
  renamedFiles: Array<{ from: string; to: string }>;
}

/** Get current git state */
export function getGitState(cwd: string): GitState {
  try {
    execSync("git rev-parse --git-dir", { cwd, encoding: "utf8", stdio: "pipe" });
  } catch {
    return { sha: null, branch: null, isRepo: false, isDirty: false };
  }

  let sha: string | null = null;
  try {
    sha = execSync("git rev-parse HEAD", { cwd, encoding: "utf8", stdio: "pipe" }).trim() || null;
  } catch {
    // No commits yet
  }

  let branch: string | null = null;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: "pipe" }).trim() || null;
    if (branch === "HEAD") branch = null; // Detached HEAD
  } catch {
    // Detached or no branch
  }

  let isDirty = false;
  try {
    // Only check tracked files (ignore untracked like .kodeklarity/)
    const status = execSync("git diff --name-only", { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    const staged = execSync("git diff --name-only --cached", { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    isDirty = status.length > 0 || staged.length > 0;
  } catch {
    // Can't determine
  }

  return { sha, branch, isRepo: true, isDirty };
}

/** Get diff between two commits (or between a commit and working tree) */
export function getGitDiff(cwd: string, fromSha: string, toSha?: string): GitDiff {
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ from: string; to: string }> = [];

  try {
    // If toSha not specified, diff against working tree (includes unstaged)
    const diffTarget = toSha ? `${fromSha}..${toSha}` : fromSha;
    const output = execSync(`git diff --name-status ${diffTarget}`, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();

    if (!output) return { changedFiles, deletedFiles, renamedFiles };

    for (const line of output.split("\n")) {
      const parts = line.split("\t");
      const status = parts[0];

      if (status === "D") {
        deletedFiles.push(parts[1]);
      } else if (status.startsWith("R")) {
        renamedFiles.push({ from: parts[1], to: parts[2] });
        changedFiles.push(parts[2]); // Treat renamed-to as changed
      } else {
        // A (added), M (modified), C (copied), T (type changed)
        if (parts[1]) changedFiles.push(parts[1]);
      }
    }
  } catch {
    // Diff failed — return empty
  }

  return { changedFiles, deletedFiles, renamedFiles };
}

/** Get currently unstaged + staged changed files */
export function getWorkingChanges(cwd: string): GitDiff {
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ from: string; to: string }> = [];

  try {
    // Unstaged changes
    const unstaged = execSync("git diff --name-status", {
      cwd, encoding: "utf8", stdio: "pipe",
    }).trim();

    // Staged changes
    const staged = execSync("git diff --name-status --cached", {
      cwd, encoding: "utf8", stdio: "pipe",
    }).trim();

    // Untracked files
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd, encoding: "utf8", stdio: "pipe",
    }).trim();

    const allLines = [
      ...unstaged.split("\n"),
      ...staged.split("\n"),
    ].filter(Boolean);

    const seen = new Set<string>();
    for (const line of allLines) {
      const parts = line.split("\t");
      const status = parts[0];
      const file = parts[1];
      if (!file || seen.has(file)) continue;
      seen.add(file);

      if (status === "D") {
        deletedFiles.push(file);
      } else if (status.startsWith("R")) {
        const toFile = parts[2];
        renamedFiles.push({ from: file, to: toFile });
        changedFiles.push(toFile);
        seen.add(toFile);
      } else {
        changedFiles.push(file);
      }
    }

    // Add untracked files
    for (const file of untracked.split("\n").filter(Boolean)) {
      if (!seen.has(file)) {
        changedFiles.push(file);
        seen.add(file);
      }
    }
  } catch {
    // Not a git repo or git error
  }

  return { changedFiles, deletedFiles, renamedFiles };
}

/** Get merge base between current branch and a target branch */
export function getMergeBase(cwd: string, targetBranch: string): string | null {
  try {
    return execSync(`git merge-base HEAD ${targetBranch}`, {
      cwd, encoding: "utf8", stdio: "pipe",
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Install git hooks for auto-rebuild */
export function installGitHooks(cwd: string): { installed: string[]; errors: string[] } {
  const installed: string[] = [];
  const errors: string[] = [];

  const hookScript = `#!/bin/sh
# KodeKlarity auto-rebuild hook
# Runs kk rebuild after pull/checkout to keep the graph up to date
if command -v kk >/dev/null 2>&1; then
  kk rebuild --quiet &
elif [ -f "./node_modules/.bin/kk" ]; then
  ./node_modules/.bin/kk rebuild --quiet &
fi
`;

  const hooks = ["post-merge", "post-checkout"];

  for (const hook of hooks) {
    try {
      const hookDir = execSync("git rev-parse --git-dir", {
        cwd, encoding: "utf8", stdio: "pipe",
      }).trim();

      const hookPath = `${hookDir}/hooks/${hook}`;
      const fs = require("node:fs");

      // Check if hook already exists
      let existingContent = "";
      try {
        existingContent = fs.readFileSync(hookPath, "utf8");
      } catch {
        // No existing hook
      }

      if (existingContent.includes("KodeKlarity")) {
        installed.push(`${hook} (already installed)`);
        continue;
      }

      // Append to existing hook or create new one
      if (existingContent) {
        fs.appendFileSync(hookPath, "\n" + hookScript);
      } else {
        fs.writeFileSync(hookPath, hookScript);
      }
      fs.chmodSync(hookPath, 0o755);
      installed.push(hook);
    } catch (err) {
      errors.push(`${hook}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { installed, errors };
}
