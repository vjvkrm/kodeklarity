import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { discover } from "./discover/index.js";
import { storeDiscoveryResult } from "./store.js";
import { traceImportEdges } from "./trace.js";
import { traceWithTypeChecker } from "./type-tracer.js";
import { loadConfig, saveConfig, generateDefaultConfig, mergeConfig, validateConfig } from "./config.js";
import { getGitState, getWorkingChanges } from "./git.js";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";
const GLOBAL_FEATURE = "__global__";

async function getQueryModule() {
  return await import("./query.js");
}

async function getDbModule() {
  return await import("./db.js");
}

function getDbPath(cwd: string): string {
  return path.join(cwd, DEFAULT_DB_PATH);
}

export async function startMcpServer() {
  const server = new McpServer({
    name: "kodeklarity",
    version: "0.1.0",
  });

  // --- kk_init ---
  server.tool(
    "kk_init",
    `Build the code graph for the current project. Scans all TypeScript files, detects frameworks (Next.js, Drizzle, NestJS, Express, Trigger.dev), discovers boundary nodes (routes, server actions, tables, jobs), and traces import relationships between them. Stores the graph in .kodeklarity/index/graph.sqlite and generates .kodeklarity/config.json.

Run this first time you open a project, or after significant code changes. Use force=true to regenerate config from scratch.`,
    { force: z.boolean().optional().describe("Force full rebuild and regenerate config") },
    async ({ force }) => {
      const cwd = process.cwd();
      const gitState = getGitState(cwd);

      let config = await loadConfig(cwd);
      const isFirstRun = !config;
      const result = await discover(cwd, config ?? undefined);

      if (result.nodes.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "No TypeScript project found." }) }] };
      }

      const freshConfig = generateDefaultConfig(result);
      config = (isFirstRun || force) ? freshConfig : mergeConfig(config!, freshConfig);
      await saveConfig(cwd, config);

      if (result.nodes.length > 0) {
        const depth = config.trace.maxDepth;
        const typeResult = await traceWithTypeChecker({ repoRoot: cwd, nodes: result.nodes, maxDepth: depth });
        result.edges.push(...typeResult.edges);
        const importResult = await traceImportEdges({ repoRoot: cwd, nodes: result.nodes, maxDepth: depth });
        const seen = new Set(result.edges.map((e) => `${e.from}→${e.to}`));
        for (const edge of importResult.edges) {
          if (!seen.has(`${edge.from}→${edge.to}`)) result.edges.push(edge);
        }
      }

      const storeResult = await storeDiscoveryResult(result, {
        gitSha: gitState.sha,
        gitBranch: gitState.branch,
      });

      const nodesByKind: Record<string, number> = {};
      for (const n of result.nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] || 0) + 1;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "ok",
            nodes: result.nodes.length,
            edges: result.edges.length,
            nodes_by_kind: nodesByKind,
            workspaces: result.workspaces.map((ws) => ({
              name: ws.name,
              path: ws.relativePath,
              stack: ws.stack.map((s) => s.name),
            })),
            gaps: result.gaps,
            config_path: ".kodeklarity/config.json",
            config_generated: isFirstRun,
            git_sha: gitState.sha,
            git_branch: gitState.branch,
            db_path: storeResult.dbPath,
          }),
        }],
      };
    }
  );

  // --- kk_rebuild ---
  server.tool(
    "kk_rebuild",
    `Incrementally rebuild the code graph. Checks git state — if no changes since last build, skips. If branch changed, does full rebuild. Otherwise rebuilds only what changed. Use force=true to force full rebuild.`,
    { force: z.boolean().optional().describe("Force full rebuild") },
    async ({ force }) => {
      const cwd = process.cwd();
      const { getLastBuildInfo } = await import("./store.js");
      const dbPath = getDbPath(cwd);
      const gitState = getGitState(cwd);
      const lastBuild = await getLastBuildInfo(dbPath);

      if (!force && lastBuild.sha === gitState.sha && !gitState.isDirty) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              action: "skipped",
              reason: "Graph is up to date",
              last_build_sha: lastBuild.sha,
              last_build_branch: lastBuild.branch,
            }),
          }],
        };
      }

      // Delegate to init for rebuild
      const config = await loadConfig(cwd);
      const result = await discover(cwd, config ?? undefined);

      if (result.nodes.length > 0) {
        const depth = config?.trace?.maxDepth ?? 4;
        const typeResult = await traceWithTypeChecker({ repoRoot: cwd, nodes: result.nodes, maxDepth: depth });
        result.edges.push(...typeResult.edges);
        const importResult = await traceImportEdges({ repoRoot: cwd, nodes: result.nodes, maxDepth: depth });
        const seen = new Set(result.edges.map((e) => `${e.from}→${e.to}`));
        for (const edge of importResult.edges) {
          if (!seen.has(`${edge.from}→${edge.to}`)) result.edges.push(edge);
        }
      }

      const storeResult = await storeDiscoveryResult(result, {
        gitSha: gitState.sha,
        gitBranch: gitState.branch,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "ok",
            action: "rebuilt",
            nodes: result.nodes.length,
            edges: result.edges.length,
            from_sha: lastBuild.sha,
            to_sha: gitState.sha,
            branch: gitState.branch,
          }),
        }],
      };
    }
  );

  // --- kk_impact ---
  server.tool(
    "kk_impact",
    `Trace downstream impact from a symbol. Shows what breaks if this symbol changes — which pages, services, tables, and jobs are affected downstream. Returns connections with confidence scores.`,
    {
      symbol: z.string().describe("Symbol name to trace impact from (e.g., 'createContract', 'users')"),
      depth: z.number().optional().default(4).describe("Maximum traversal depth"),
    },
    async ({ symbol, depth }) => {
      const query = await getQueryModule();
      const result = await query.queryImpact({
        dbPath: getDbPath(process.cwd()),
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // --- kk_upstream ---
  server.tool(
    "kk_upstream",
    `Trace upstream callers of a symbol. Shows what depends on this symbol — which routes, server actions, and services call it. Use this before changing a shared function to know all callers.`,
    {
      symbol: z.string().describe("Symbol name to find upstream callers for"),
      depth: z.number().optional().default(4).describe("Maximum traversal depth"),
    },
    async ({ symbol, depth }) => {
      const query = await getQueryModule();
      const result = await query.queryUpstream({
        dbPath: getDbPath(process.cwd()),
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // --- kk_downstream ---
  server.tool(
    "kk_downstream",
    `Trace downstream callees of a symbol. Shows what this symbol calls — which services, queries, tables, and external APIs it depends on.`,
    {
      symbol: z.string().describe("Symbol name to trace downstream from"),
      depth: z.number().optional().default(4).describe("Maximum traversal depth"),
    },
    async ({ symbol, depth }) => {
      const query = await getQueryModule();
      const result = await query.queryDownstream({
        dbPath: getDbPath(process.cwd()),
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // --- kk_side_effects ---
  server.tool(
    "kk_side_effects",
    `Find reachable side effects from a symbol. Shows which database tables, external APIs, events, and background jobs are triggered when this symbol executes.`,
    {
      symbol: z.string().describe("Symbol name to trace side effects from"),
      depth: z.number().optional().default(6).describe("Maximum traversal depth"),
    },
    async ({ symbol, depth }) => {
      const query = await getQueryModule();
      const result = await query.querySideEffects({
        dbPath: getDbPath(process.cwd()),
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // --- kk_why ---
  server.tool(
    "kk_why",
    `Explain the shortest path between two symbols in the code graph. Use this to understand how two seemingly unrelated pieces of code are connected.`,
    {
      from: z.string().describe("Source symbol name"),
      to: z.string().describe("Target symbol name"),
      depth: z.number().optional().default(6).describe("Maximum search depth"),
    },
    async ({ from, to, depth }) => {
      const query = await getQueryModule();
      const result = await query.queryWhy({
        dbPath: getDbPath(process.cwd()),
        feature: GLOBAL_FEATURE,
        from,
        to,
        depth,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // --- kk_risk ---
  server.tool(
    "kk_risk",
    `Assess risk of current uncommitted changes. Reads git diff (unstaged + staged + untracked), finds which graph nodes are affected, traces downstream impact, and returns a risk score (0-100) with breakdown by node type and side effects.`,
    {},
    async () => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const workingChanges = getWorkingChanges(cwd);
      const changedFiles = workingChanges.changedFiles;

      if (changedFiles.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "ok", risk_score: 0, risk_label: "none", changed_files: [], message: "No changes detected" }),
          }],
        };
      }

      const db = await getDbModule();
      await db.initGraphDb(dbPath);
      const database = db.openDatabase(dbPath);

      try {
        db.runMigrations(database);

        const affectedNodes: any[] = [];
        for (const file of changedFiles) {
          const nodes = database.prepare(
            "SELECT node_id, kind, symbol, file FROM nodes WHERE feature_name = ? AND file LIKE ?"
          ).all(GLOBAL_FEATURE, `%${file}%`);
          affectedNodes.push(...nodes);
        }

        let totalImpact = 0;
        let sideEffectCount = 0;
        const impactedKinds: Record<string, number> = {};

        for (const node of affectedNodes) {
          const impacts = database.prepare(`
            WITH RECURSIVE walk AS (
              SELECT to_node_id, edge_type, 1 as depth
              FROM edges WHERE feature_name = ? AND from_node_id = ?
              UNION ALL
              SELECT e.to_node_id, e.edge_type, w.depth + 1
              FROM walk w JOIN edges e ON e.feature_name = ? AND e.from_node_id = w.to_node_id
              WHERE w.depth < 3
            )
            SELECT DISTINCT to_node_id, edge_type FROM walk
          `).all(GLOBAL_FEATURE, node.node_id, GLOBAL_FEATURE);

          totalImpact += impacts.length;
          for (const imp of impacts) {
            const targetNode = database.prepare(
              "SELECT kind FROM nodes WHERE feature_name = ? AND node_id = ?"
            ).get(GLOBAL_FEATURE, (imp as any).to_node_id) as any;
            if (targetNode) {
              impactedKinds[targetNode.kind] = (impactedKinds[targetNode.kind] || 0) + 1;
              if (["table", "external_api", "event", "background_job"].includes(targetNode.kind)) {
                sideEffectCount++;
              }
            }
          }
        }

        const nodeRatio = Math.min(affectedNodes.length / 20, 1);
        const impactRatio = Math.min(totalImpact / 100, 1);
        const sideEffectRatio = Math.min(sideEffectCount / 10, 1);
        const riskScore = Math.round((nodeRatio * 0.3 + impactRatio * 0.4 + sideEffectRatio * 0.3) * 100);
        const riskLabel = riskScore >= 70 ? "high" : riskScore >= 40 ? "medium" : "low";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              changed_files: changedFiles,
              affected_nodes: affectedNodes.length,
              downstream_impacts: totalImpact,
              side_effect_count: sideEffectCount,
              impacted_kinds: impactedKinds,
              risk_score: riskScore,
              risk_label: riskLabel,
            }),
          }],
        };
      } finally {
        database.close();
      }
    }
  );

  // --- kk_status ---
  server.tool(
    "kk_status",
    `Show current graph overview — node count, edge count, breakdown by type, last build info. Use this to check if the graph exists and is up to date before running other queries.`,
    {},
    async () => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const db = await getDbModule();

      try {
        await db.initGraphDb(dbPath);
        const database = db.openDatabase(dbPath);

        try {
          db.runMigrations(database);

          const nodeCount = (database.prepare(
            "SELECT COUNT(*) as cnt FROM nodes WHERE feature_name = ?"
          ).get(GLOBAL_FEATURE) as any)?.cnt || 0;

          const edgeCount = (database.prepare(
            "SELECT COUNT(*) as cnt FROM edges WHERE feature_name = ?"
          ).get(GLOBAL_FEATURE) as any)?.cnt || 0;

          const nodeKinds = database.prepare(
            "SELECT kind, COUNT(*) as cnt FROM nodes WHERE feature_name = ? GROUP BY kind ORDER BY cnt DESC"
          ).all(GLOBAL_FEATURE);

          const edgeTypes = database.prepare(
            "SELECT edge_type, COUNT(*) as cnt FROM edges WHERE feature_name = ? GROUP BY edge_type ORDER BY cnt DESC"
          ).all(GLOBAL_FEATURE);

          let gitSha: string | null = null;
          let gitBranch: string | null = null;
          try {
            gitSha = (database.prepare("SELECT value FROM kv WHERE key = 'last_build_sha'").get() as any)?.value;
            gitBranch = (database.prepare("SELECT value FROM kv WHERE key = 'last_build_branch'").get() as any)?.value;
          } catch { /* no kv table */ }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "ok",
                nodes: nodeCount,
                edges: edgeCount,
                nodes_by_kind: Object.fromEntries((nodeKinds as any[]).map((r) => [r.kind, r.cnt])),
                edges_by_type: Object.fromEntries((edgeTypes as any[]).map((r) => [r.edge_type, r.cnt])),
                git_sha: gitSha,
                git_branch: gitBranch,
              }),
            }],
          };
        } finally {
          database.close();
        }
      } catch {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "error", message: "No graph found. Run kk_init first." }),
          }],
        };
      }
    }
  );

  // --- kk_config ---
  server.tool(
    "kk_config",
    `Read the current .kodeklarity/config.json. Use this to understand how the graph is configured, then edit the config file directly to add custom boundaries, adjust workspace adapters, or tune trace depth. After editing, run kk_rebuild to apply changes.`,
    {},
    async () => {
      const config = await loadConfig(process.cwd());
      if (!config) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "No config found. Run kk_init first." }) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "ok", config }) }],
      };
    }
  );

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
