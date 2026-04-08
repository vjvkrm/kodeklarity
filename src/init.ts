import path from "node:path";
import { execSync } from "node:child_process";
import { discover } from "./discover/index.js";
import type { DiscoveryResult } from "./discover/index.js";
import { storeDiscoveryResult } from "./store.js";
import type { StoreResult } from "./store.js";
import { traceImportEdges } from "./trace.js";
import {
  loadConfig,
  saveConfig,
  generateDefaultConfig,
  mergeConfig,
  validateConfig,
  type KKConfig,
} from "./config.js";

interface InitOptions {
  cwd: string;
  force: boolean;
  json: boolean;
}

function getGitHeadSha(cwd: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function formatHumanOutput(result: DiscoveryResult, gitSha: string | null): void {
  console.log("");

  // Workspace info
  if (result.workspaces.length === 1 && result.workspaces[0].relativePath === ".") {
    const ws = result.workspaces[0];
    const stackNames = ws.stack.map((s) => s.name).join(", ");
    console.log(`  Project: ${ws.name}`);
    console.log(`  Stack:   ${stackNames || "TypeScript"}`);
  } else {
    console.log(`  Monorepo: ${result.workspaces.length} workspaces`);
    for (const ws of result.workspaces) {
      const stackNames = ws.stack.map((s) => s.name).join(", ");
      console.log(`    ${ws.relativePath.padEnd(30)} → ${stackNames || "TypeScript"}`);
    }
  }

  console.log("");

  // Node stats
  const kinds = result.stats.nodesByKind;
  const parts: string[] = [];
  if (kinds.route) parts.push(`Routes: ${kinds.route}`);
  if (kinds.api_route) parts.push(`API routes: ${kinds.api_route}`);
  if (kinds.server_action) parts.push(`Server actions: ${kinds.server_action}`);
  if (kinds.controller) parts.push(`Controllers: ${kinds.controller}`);
  if (kinds.service) parts.push(`Services: ${kinds.service}`);
  if (kinds.table) parts.push(`Tables: ${kinds.table}`);
  if (kinds.background_job) parts.push(`Background jobs: ${kinds.background_job}`);
  if (kinds.external_api) parts.push(`External APIs: ${kinds.external_api}`);
  if (kinds.middleware) parts.push(`Middleware: ${kinds.middleware}`);
  if (kinds.hook) parts.push(`Hooks: ${kinds.hook}`);
  if (kinds.context) parts.push(`Contexts: ${kinds.context}`);
  if (kinds.event) parts.push(`Events: ${kinds.event}`);
  if (kinds.layout) parts.push(`Layouts: ${kinds.layout}`);
  if (kinds.module) parts.push(`Modules: ${kinds.module}`);
  if (kinds.rls_policy) parts.push(`RLS policies: ${kinds.rls_policy}`);

  console.log(`  Graph: ${result.nodes.length} nodes, ${result.edges.length} edges`);
  if (parts.length > 0) {
    // Print in rows of 3
    for (let i = 0; i < parts.length; i += 3) {
      const row = parts.slice(i, i + 3).map((p) => p.padEnd(25)).join("");
      console.log(`    ${row}`);
    }
  }

  console.log("");

  if (gitSha) {
    console.log(`  Commit: ${gitSha.slice(0, 7)}`);
  }

  // Gaps
  if (result.gaps.length > 0) {
    console.log("");
    console.log(`  Gaps (${result.gaps.length} files need agent review):`);
    for (const gap of result.gaps.slice(0, 10)) {
      console.log(`    ${gap.file}:${gap.lines || "?"} — ${gap.reason}`);
    }
    if (result.gaps.length > 10) {
      console.log(`    ... and ${result.gaps.length - 10} more`);
    }
  }

  console.log("");
}

function buildJsonOutput(result: DiscoveryResult, gitSha: string | null): Record<string, unknown> {
  return {
    status: "ok",
    repo_root: result.repoRoot,
    git_sha: gitSha,
    workspaces: result.workspaces.map((ws) => ({
      name: ws.name,
      path: ws.relativePath,
      stack: ws.stack.map((s) => ({ name: s.name, version: s.version, adapter: s.adapter })),
    })),
    graph: {
      nodes: result.nodes.length,
      edges: result.edges.length,
    },
    coverage: {
      files_scanned: result.stats.filesScanned,
      files_with_boundaries: result.stats.filesWithBoundaries,
      files_needing_review: result.stats.filesNeedingReview,
    },
    nodes_by_kind: result.stats.nodesByKind,
    edges_by_type: result.stats.edgesByType,
    gaps: result.gaps,
    // Include raw nodes/edges for agent consumption
    boundary_nodes: result.nodes,
    boundary_edges: result.edges,
  };
}

export async function handleInit(args: string[]): Promise<number> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force") flags.force = true;
    if (args[i] === "--json") flags.json = true;
  }

  const options: InitOptions = {
    cwd: process.cwd(),
    force: flags.force === true,
    json: flags.json === true,
  };

  try {
    // Load or generate config
    let config = await loadConfig(options.cwd);
    const isFirstRun = !config;

    const result = await discover(options.cwd, config ?? undefined);
    const gitSha = getGitHeadSha(options.cwd);

    if (result.nodes.length === 0 && result.workspaces.length === 0) {
      const error = {
        status: "error",
        error_code: "NO_PROJECT_FOUND",
        message: "No package.json found. Run kk init from a TypeScript project root.",
      };

      if (options.json) {
        console.log(JSON.stringify(error, null, 2));
      } else {
        console.error(error.message);
      }
      return 1;
    }

    // Generate or merge config
    const freshConfig = generateDefaultConfig(result);
    if (isFirstRun || options.force) {
      config = freshConfig;
    } else {
      config = mergeConfig(config!, freshConfig);
    }

    // Validate config
    const configIssues = validateConfig(config);

    // Save config
    const configPath = await saveConfig(options.cwd, config);

    // Trace import edges between discovered boundary nodes
    if (result.nodes.length > 0) {
      const traceResult = await traceImportEdges({
        repoRoot: options.cwd,
        nodes: result.nodes,
        maxDepth: config.trace.maxDepth,
      });
      // Merge traced edges into discovery result
      result.edges.push(...traceResult.edges);
      // Update stats
      for (const edge of traceResult.edges) {
        result.stats.edgesByType[edge.edgeType] = (result.stats.edgesByType[edge.edgeType] || 0) + 1;
      }
    }

    // Store graph in SQLite
    let storeResult: StoreResult | null = null;
    if (result.nodes.length > 0) {
      storeResult = await storeDiscoveryResult(result, { gitSha });
    }

    if (options.json) {
      const output = buildJsonOutput(result, gitSha);
      if (storeResult) {
        output.db_path = storeResult.dbPath;
        output.build_id = storeResult.buildId;
      }
      output.config_path = configPath;
      output.config_issues = configIssues;
      output.config_generated = isFirstRun;
      console.log(JSON.stringify(output, null, 2));
    } else {
      formatHumanOutput(result, gitSha);
      if (storeResult) {
        console.log(`  Stored: ${storeResult.dbPath}`);
      }
      console.log(`  Config: ${configPath}${isFirstRun ? " (generated)" : ""}`);
      if (configIssues.length > 0) {
        console.log(`  Config issues: ${configIssues.length}`);
        for (const issue of configIssues) {
          console.log(`    ${issue.field}: ${issue.issue}`);
        }
      }
      console.log("");
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = {
      status: "error",
      error_code: "INIT_FAILED",
      message: `Discovery failed: ${message}`,
    };

    if (options.json) {
      console.log(JSON.stringify(error, null, 2));
    } else {
      console.error(error.message);
    }
    return 1;
  }
}
