import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace, DiscoveryResult } from "./discover/types.js";

const CONFIG_DIR = ".kodeklarity";
const CONFIG_FILE = "config.json";

/** Custom boundary pattern — agent can add these to discover project-specific boundaries */
export interface CustomBoundary {
  name: string;
  kind: string; // node kind: "query", "service", "repository", "helper", etc.
  glob: string; // file pattern: "src/lib/queries/*.ts"
  symbolPattern?: string; // regex for exported symbols to capture
  reason: string; // human-readable description
}

/** Custom edge type rule */
export interface EdgeRule {
  when: {
    sourceKind: string;
    targetKind: string;
  };
  edgeType: string;
}

/** Full project config — agent-editable */
export interface KKConfig {
  // Schema version for forward compat
  version: 1;

  // Stack detection
  stack: {
    detected: string[]; // auto-detected adapter names
    enabled: string[]; // which adapters to run
    disabled: string[]; // explicitly disabled
  };

  // Per-workspace adapter overrides
  workspaces: Record<
    string,
    {
      adapters?: string[]; // override which adapters run on this workspace
      exclude?: string[]; // extra exclude patterns for this workspace
    }
  >;

  // Custom boundary patterns — the power feature for agents
  customBoundaries: CustomBoundary[];

  // Global exclude patterns
  exclude: string[];

  // Custom edge type rules
  edgeRules: EdgeRule[];

  // Import alias overrides (supplement tsconfig paths)
  importAliases: Record<string, string>;

  // Tracing config
  trace: {
    maxDepth: number;
    excludeTypeOnlyImports: boolean;
  };

  // Metadata
  _meta: {
    generatedAt: string;
    lastModifiedBy: string; // "kk_init" or "agent" or "human"
    projectName: string;
  };
}

/** Generate default config from discovery results */
export function generateDefaultConfig(result: DiscoveryResult): KKConfig {
  const allAdapters = new Set<string>();
  for (const ws of result.workspaces) {
    for (const s of ws.stack) {
      allAdapters.add(s.adapter);
    }
  }

  // Build workspace overrides — only set adapters for workspaces that don't match root
  const workspaceOverrides: KKConfig["workspaces"] = {};
  const rootWorkspace = result.workspaces.find((ws) => ws.relativePath === ".");
  const rootAdapters = rootWorkspace
    ? rootWorkspace.stack.map((s) => s.adapter)
    : [...allAdapters];

  for (const ws of result.workspaces) {
    const wsAdapters = ws.stack.map((s) => s.adapter);
    // Determine what this workspace actually needs based on its own deps
    const ownDeps = ws.packageJson.dependencies as Record<string, string> | undefined;
    const ownDevDeps = ws.packageJson.devDependencies as Record<string, string> | undefined;
    const allDeps = { ...ownDeps, ...ownDevDeps };

    // If workspace has its own deps, use only matching adapters
    // If it has no deps (inherits from root), be conservative — only generic
    const hasOwnDeps = Object.keys(allDeps).length > 0;

    if (ws.relativePath !== ".") {
      const inferredAdapters: string[] = [];
      if (allDeps["next"]) inferredAdapters.push("nextjs");
      if (allDeps["@nestjs/core"]) inferredAdapters.push("nestjs");
      if (allDeps["express"] && !allDeps["next"]) inferredAdapters.push("express");
      if (allDeps["drizzle-orm"] || allDeps["drizzle-kit"]) inferredAdapters.push("drizzle");
      if (allDeps["@trigger.dev/sdk"]) inferredAdapters.push("triggerdev");
      if (allDeps["react"] && !allDeps["next"]) inferredAdapters.push("react");
      inferredAdapters.push("generic");

      workspaceOverrides[ws.relativePath] = {
        adapters: hasOwnDeps ? inferredAdapters : ["generic"],
      };
    }
  }

  return {
    version: 1,
    stack: {
      detected: [...allAdapters],
      enabled: [...allAdapters],
      disabled: [],
    },
    workspaces: workspaceOverrides,
    customBoundaries: [],
    exclude: [
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/*.test.tsx",
      "**/*.spec.tsx",
      "tests/**",
      "scripts/**",
      "__tests__/**",
    ],
    edgeRules: [],
    importAliases: {},
    trace: {
      maxDepth: 4,
      excludeTypeOnlyImports: true,
    },
    _meta: {
      generatedAt: new Date().toISOString(),
      lastModifiedBy: "kk_init",
      projectName: rootWorkspace?.name || path.basename(result.repoRoot),
    },
  };
}

/** Load config from disk, return null if doesn't exist */
export async function loadConfig(repoRoot: string): Promise<KKConfig | null> {
  const configPath = path.join(repoRoot, CONFIG_DIR, CONFIG_FILE);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw) as KKConfig;
  } catch {
    return null;
  }
}

/** Save config to disk */
export async function saveConfig(repoRoot: string, config: KKConfig): Promise<string> {
  const configDir = path.join(repoRoot, CONFIG_DIR);
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, CONFIG_FILE);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

/** Merge existing config with new auto-detection (preserve agent edits) */
export function mergeConfig(existing: KKConfig, freshDetection: KKConfig): KKConfig {
  return {
    ...existing,
    // Update detected stack but keep enabled/disabled as agent set them
    stack: {
      detected: freshDetection.stack.detected,
      enabled: existing.stack.enabled,
      disabled: existing.stack.disabled,
    },
    // Keep agent's workspace overrides, add new workspaces
    workspaces: {
      ...freshDetection.workspaces,
      ...existing.workspaces, // agent overrides win
    },
    // Keep all agent customizations
    customBoundaries: existing.customBoundaries,
    exclude: existing.exclude,
    edgeRules: existing.edgeRules,
    importAliases: existing.importAliases,
    trace: existing.trace,
    // Update meta
    _meta: {
      ...existing._meta,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** Get effective adapters for a workspace, respecting config overrides */
export function getWorkspaceAdapters(config: KKConfig, workspaceRelPath: string): string[] {
  const override = config.workspaces[workspaceRelPath];
  if (override?.adapters) {
    // Filter by enabled/disabled
    return override.adapters.filter(
      (a) => config.stack.enabled.includes(a) && !config.stack.disabled.includes(a)
    );
  }
  // Default to all enabled adapters
  return config.stack.enabled.filter((a) => !config.stack.disabled.includes(a));
}

/** Validate config and return issues */
export function validateConfig(config: KKConfig): Array<{ field: string; issue: string }> {
  const issues: Array<{ field: string; issue: string }> = [];

  if (config.version !== 1) {
    issues.push({ field: "version", issue: `Unsupported config version: ${config.version}` });
  }

  for (const cb of config.customBoundaries) {
    if (!cb.name) issues.push({ field: "customBoundaries", issue: "Custom boundary missing name" });
    if (!cb.kind) issues.push({ field: "customBoundaries", issue: `Custom boundary '${cb.name}' missing kind` });
    if (!cb.glob) issues.push({ field: "customBoundaries", issue: `Custom boundary '${cb.name}' missing glob` });
  }

  for (const rule of config.edgeRules) {
    if (!rule.when?.sourceKind || !rule.when?.targetKind) {
      issues.push({ field: "edgeRules", issue: "Edge rule missing when.sourceKind or when.targetKind" });
    }
    if (!rule.edgeType) {
      issues.push({ field: "edgeRules", issue: "Edge rule missing edgeType" });
    }
  }

  return issues;
}
