import fs from "node:fs/promises";
import path from "node:path";

/** Directories to always exclude from scanning */
const EXCLUDED_DIRS = [
  "node_modules", ".next", "dist", ".turbo", ".nx", "coverage",
  ".git", ".pnpm", "disable", ".cache", "build", "out",
];

/** Check if a file path should be excluded from scanning */
export function shouldExclude(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return EXCLUDED_DIRS.some((dir) => normalized.includes(`/${dir}/`) || normalized.includes(`${dir}/`));
}

/** Read file content, return null if doesn't exist */
export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Find files matching a glob pattern within a directory */
export async function findFiles(baseDir: string, patterns: string[]): Promise<string[]> {
  const results: string[] = [];

  for (const pattern of patterns) {
    try {
      const { glob } = await import("node:fs/promises");
      for await (const entry of glob(path.join(baseDir, pattern), { withFileTypes: false })) {
        results.push(typeof entry === "string" ? entry : String(entry));
      }
    } catch {
      // Pattern didn't match
    }
  }

  return [...new Set(results)].sort();
}

/** Check if a file contains a string/pattern */
export async function fileContains(filePath: string, search: string | RegExp): Promise<boolean> {
  const content = await readFileSafe(filePath);
  if (!content) return false;

  if (typeof search === "string") {
    return content.includes(search);
  }
  return search.test(content);
}

/** Find the line number of the first occurrence of a pattern in file content */
export function findLineNumber(content: string, search: string | RegExp): number {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (typeof search === "string" ? lines[i].includes(search) : search.test(lines[i])) {
      return i + 1;
    }
  }
  return 1;
}

/** Make a path relative to repo root */
export function toRelative(absPath: string, repoRoot: string): string {
  return path.relative(repoRoot, absPath).replace(/\\/g, "/");
}

/** Generate a node ID from file path and symbol */
export function makeNodeId(kind: string, filePath: string, symbol: string): string {
  const clean = filePath.replace(/\\/g, "/").replace(/\.[^.]+$/, "");
  return `${kind}:${clean}:${symbol}`;
}

/** Get dependency version from package.json, checking both deps and devDeps */
export function getDepVersion(
  packageJson: Record<string, unknown>,
  packageName: string
): string | null {
  const deps = (packageJson.dependencies ?? {}) as Record<string, string>;
  const devDeps = (packageJson.devDependencies ?? {}) as Record<string, string>;
  return deps[packageName] ?? devDeps[packageName] ?? null;
}
