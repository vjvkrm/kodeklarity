import path from "node:path";
import { discover } from "./discover/index.js";
import { storeDiscoveryResult, getLastBuildInfo } from "./store.js";
import { traceImportEdges } from "./trace.js";
import { traceWithTypeChecker } from "./type-tracer.js";
import { loadConfig } from "./config.js";
import { getGitState, getGitDiff } from "./git.js";

interface RebuildOptions {
  cwd: string;
  force: boolean;
  json: boolean;
  quiet: boolean;
}

export async function handleRebuild(args: string[]): Promise<number> {
  const flags: Record<string, boolean> = {};
  for (const arg of args) {
    if (arg === "--force") flags.force = true;
    if (arg === "--json") flags.json = true;
    if (arg === "--quiet") flags.quiet = true;
  }

  const options: RebuildOptions = {
    cwd: process.cwd(),
    force: flags.force === true,
    json: flags.json === true,
    quiet: flags.quiet === true,
  };

  const dbPath = path.join(options.cwd, ".kodeklarity/index/graph.sqlite");

  try {
    // Get current git state
    const gitState = getGitState(options.cwd);
    if (!gitState.isRepo) {
      return emitResult(options, {
        status: "ok",
        action: "full_rebuild",
        reason: "Not a git repository — running full init",
      }, async () => {
        // Fall through to full init
        const { handleInit } = await import("./init.js");
        return handleInit(args);
      });
    }

    // Get last build info
    const lastBuild = await getLastBuildInfo(dbPath);

    // Determine if we need a full rebuild or incremental
    let needsFullRebuild = options.force;
    let reason = "";

    if (!lastBuild.sha) {
      needsFullRebuild = true;
      reason = "No previous build found";
    } else if (!gitState.sha) {
      needsFullRebuild = true;
      reason = "No commits in repository";
    } else if (lastBuild.branch && gitState.branch && lastBuild.branch !== gitState.branch) {
      // Branch changed — check if it's a significant divergence
      needsFullRebuild = true;
      reason = `Branch changed: ${lastBuild.branch} → ${gitState.branch}`;
    } else if (lastBuild.sha === gitState.sha && !gitState.isDirty) {
      // No changes since last build
      const result = {
        status: "ok",
        action: "skipped",
        reason: "Graph is up to date",
        last_build_sha: lastBuild.sha,
        last_build_branch: lastBuild.branch,
        last_build_at: lastBuild.builtAt,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.log("  Graph is up to date. No changes since last build.");
        console.log(`  Last build: ${lastBuild.builtAt} (${lastBuild.sha?.slice(0, 7)})`);
      }
      return 0;
    }

    if (needsFullRebuild) {
      if (!options.quiet) {
        if (options.json) {
          // Will be part of init output
        } else {
          console.log(`  Full rebuild: ${reason}`);
        }
      }
      const { handleInit } = await import("./init.js");
      return handleInit(options.force ? ["--force", ...(options.json ? ["--json"] : [])] : (options.json ? ["--json"] : []));
    }

    // Incremental rebuild — diff since last build
    const diff = getGitDiff(options.cwd, lastBuild.sha!);
    const totalChanges = diff.changedFiles.length + diff.deletedFiles.length + diff.renamedFiles.length;

    if (totalChanges === 0 && !gitState.isDirty) {
      const result = {
        status: "ok",
        action: "skipped",
        reason: "No file changes since last build",
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.log("  No file changes since last build.");
      }
      return 0;
    }

    // Filter to only TS/TSX files
    const relevantExtensions = [".ts", ".tsx", ".js", ".jsx"];
    const changedTsFiles = diff.changedFiles.filter((f) =>
      relevantExtensions.some((ext) => f.endsWith(ext))
    );

    // If more than 30% of source files changed, do full rebuild (faster than incremental)
    if (changedTsFiles.length > 100) {
      if (!options.quiet && !options.json) {
        console.log(`  ${changedTsFiles.length} files changed — running full rebuild`);
      }
      const { handleInit } = await import("./init.js");
      return handleInit(options.json ? ["--json"] : []);
    }

    // Incremental: run full discovery but only on the project
    // (For now, incremental = full rediscovery. True incremental per-file is a future optimization.)
    // The key value is: we skip rebuild when nothing changed.
    if (!options.quiet && !options.json) {
      console.log(`  ${changedTsFiles.length} files changed since ${lastBuild.sha?.slice(0, 7)} — rebuilding...`);
    }

    const config = await loadConfig(options.cwd);
    const result = await discover(options.cwd, config ?? undefined);

    if (result.nodes.length > 0) {
      const depth = config?.trace?.maxDepth ?? 4;
      // Type-aware tracing first, then file-level fallback
      const typeResult = await traceWithTypeChecker({ repoRoot: options.cwd, nodes: result.nodes, maxDepth: depth });
      result.edges.push(...typeResult.edges);

      const importResult = await traceImportEdges({ repoRoot: options.cwd, nodes: result.nodes, maxDepth: depth });
      const existingEdges = new Set(result.edges.map((e) => `${e.from}→${e.to}`));
      for (const edge of importResult.edges) {
        if (!existingEdges.has(`${edge.from}→${edge.to}`)) {
          result.edges.push(edge);
        }
      }
    }

    const storeResult = await storeDiscoveryResult(result, {
      gitSha: gitState.sha,
      gitBranch: gitState.branch,
    });

    const output = {
      status: "ok",
      action: "rebuilt",
      changed_files: changedTsFiles.length,
      deleted_files: diff.deletedFiles.length,
      from_sha: lastBuild.sha,
      to_sha: gitState.sha,
      branch: gitState.branch,
      nodes: result.nodes.length,
      edges: result.edges.length,
      db_path: storeResult.dbPath,
      build_id: storeResult.buildId,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (!options.quiet) {
      console.log(`  Rebuilt: ${result.nodes.length} nodes, ${result.edges.length} edges`);
      console.log(`  Changed: ${changedTsFiles.length} files (${lastBuild.sha?.slice(0, 7)} → ${gitState.sha?.slice(0, 7)})`);
      console.log(`  Branch: ${gitState.branch || "detached"}`);
      console.log(`  Stored: ${storeResult.dbPath}`);
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ status: "error", error_code: "REBUILD_FAILED", message }, null, 2));
    } else if (!options.quiet) {
      console.error(`Rebuild failed: ${message}`);
    }
    return 1;
  }
}

async function emitResult(
  options: RebuildOptions,
  preResult: Record<string, unknown>,
  fallback: () => Promise<number>
): Promise<number> {
  if (!options.quiet && !options.json) {
    console.log(`  ${preResult.reason}`);
  }
  return fallback();
}
