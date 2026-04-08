import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "node:fs/promises";
import type { Workspace } from "./types.js";

interface WorkspaceConfig {
  tool: string; // "npm", "pnpm", "turborepo", "nx"
  patterns: string[];
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function detectWorkspaceConfig(repoRoot: string): Promise<WorkspaceConfig | null> {
  const rootPkg = await readJsonSafe(path.join(repoRoot, "package.json"));
  if (!rootPkg) return null;

  // Check for workspace patterns in package.json (npm/yarn/pnpm)
  const workspaces = rootPkg.workspaces;
  let patterns: string[] = [];

  if (Array.isArray(workspaces)) {
    patterns = workspaces.filter((w): w is string => typeof w === "string");
  } else if (workspaces && typeof workspaces === "object" && "packages" in workspaces) {
    const pkgs = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(pkgs)) {
      patterns = pkgs.filter((w): w is string => typeof w === "string");
    }
  }

  if (patterns.length > 0) {
    // Determine specific tool
    const hasTurboJson = await fileExists(path.join(repoRoot, "turbo.json"));
    if (hasTurboJson) return { tool: "turborepo", patterns };

    const hasPnpmWorkspace = await fileExists(path.join(repoRoot, "pnpm-workspace.yaml"));
    if (hasPnpmWorkspace) return { tool: "pnpm", patterns };

    return { tool: "npm", patterns };
  }

  // Check pnpm-workspace.yaml separately (may not have workspaces in package.json)
  try {
    const pnpmWs = await fs.readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const match = pnpmWs.match(/packages:\s*\n((?:\s+-\s+.+\n?)*)/);
    if (match) {
      patterns = match[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*['"]?/, "").replace(/['"]?\s*$/, ""))
        .filter((p) => p.length > 0);
      if (patterns.length > 0) return { tool: "pnpm", patterns };
    }
  } catch {
    // No pnpm workspace
  }

  // Check for nx.json
  const hasNxJson = await fileExists(path.join(repoRoot, "nx.json"));
  if (hasNxJson) {
    // Nx auto-discovers projects by looking for package.json in subdirs
    return { tool: "nx", patterns: ["packages/*", "apps/*", "libs/*"] };
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveWorkspacePatterns(
  repoRoot: string,
  patterns: string[]
): Promise<string[]> {
  const dirs: string[] = [];

  for (const pattern of patterns) {
    // Workspace patterns like "packages/*" or "apps/**"
    const globPattern = pattern.endsWith("/*") || pattern.endsWith("/**")
      ? pattern
      : `${pattern}`;

    try {
      // Find directories matching the pattern that contain package.json
      const entries = [];
      for await (const entry of glob(path.join(repoRoot, globPattern), { withFileTypes: false })) {
        entries.push(entry as unknown as string);
      }

      for (const entry of entries) {
        const entryPath = typeof entry === "string" ? entry : String(entry);
        const pkgPath = path.join(entryPath, "package.json");
        if (await fileExists(pkgPath)) {
          dirs.push(entryPath);
        }
      }
    } catch {
      // Pattern didn't match anything
    }
  }

  return [...new Set(dirs)].sort();
}

export async function detectWorkspaces(repoRoot: string): Promise<{
  tool: string | null;
  workspaces: Workspace[];
}> {
  const config = await detectWorkspaceConfig(repoRoot);

  if (!config) {
    // Single repo — treat root as the only workspace
    const rootPkg = await readJsonSafe(path.join(repoRoot, "package.json"));
    if (!rootPkg) {
      return { tool: null, workspaces: [] };
    }

    return {
      tool: null,
      workspaces: [
        {
          name: (rootPkg.name as string) || path.basename(repoRoot),
          path: repoRoot,
          relativePath: ".",
          packageJson: rootPkg,
          stack: [],
        },
      ],
    };
  }

  // Monorepo — resolve workspace dirs
  const workspaceDirs = await resolveWorkspacePatterns(repoRoot, config.patterns);
  const workspaces: Workspace[] = [];

  for (const wsDir of workspaceDirs) {
    const pkg = await readJsonSafe(path.join(wsDir, "package.json"));
    if (!pkg) continue;

    workspaces.push({
      name: (pkg.name as string) || path.basename(wsDir),
      path: wsDir,
      relativePath: path.relative(repoRoot, wsDir),
      packageJson: pkg,
      stack: [],
    });
  }

  // Also include root if it has its own source code (not just workspace config)
  const rootPkg = await readJsonSafe(path.join(repoRoot, "package.json"));
  if (rootPkg) {
    const rootHasSrc =
      (await fileExists(path.join(repoRoot, "src", "index.ts"))) ||
      (await fileExists(path.join(repoRoot, "src", "index.js"))) ||
      (await fileExists(path.join(repoRoot, "src", "main.ts"))) ||
      (await fileExists(path.join(repoRoot, "app", "layout.tsx"))) ||
      (await fileExists(path.join(repoRoot, "src", "app", "layout.tsx"))); // Next.js src/app dir

    if (rootHasSrc && workspaces.every((ws) => ws.path !== repoRoot)) {
      workspaces.unshift({
        name: (rootPkg.name as string) || path.basename(repoRoot),
        path: repoRoot,
        relativePath: ".",
        packageJson: rootPkg,
        stack: [],
      });
    }
  }

  return { tool: config.tool, workspaces };
}
