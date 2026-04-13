import { randomUUID } from "node:crypto";
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
import { compactifyTraversal, compactifyRisk, compactifyStatus, summarizeTraversal } from "./compact.js";

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

/** Resolve a symbol name to a node_id using the same logic as kk_impact/kk_upstream. */
async function resolveSymbol(database: any, symbol: string): Promise<{ nodeId: string | null; error: string | null }> {
  const query = await getQueryModule();
  const result = query.resolveNodeReference(database, GLOBAL_FEATURE, symbol);
  if (result.ok) {
    return { nodeId: result.node.node_id, error: null };
  }
  if (result.error?.code === "ambiguous_reference") {
    return { nodeId: null, error: `Symbol "${symbol}" matches multiple nodes: ${result.error.matches.join(", ")}. Be more specific.` };
  }
  return { nodeId: null, error: `No node found for "${symbol}". Use kk_search to find valid symbols.` };
}

/** Fetch memories for node_ids found in a traversal result. Returns [] if no memories or table missing. */
async function fetchMemoriesForTraversal(dbPath: string, result: any): Promise<any[]> {
  const items = result.impacts || result.upstreams || result.side_effects || [];
  const startNodes = result.start_nodes || [];

  // Collect all node_ids from the traversal
  const nodeIds = new Set<string>();
  for (const sn of startNodes) {
    if (sn.node_id) nodeIds.add(sn.node_id);
  }
  for (const item of items) {
    if (item.from_node_id) nodeIds.add(item.from_node_id);
    if (item.to_node_id) nodeIds.add(item.to_node_id);
  }

  if (nodeIds.size === 0) return [];

  const db = await getDbModule();
  const database = db.openDatabase(dbPath);
  try {
    const ids = [...nodeIds];
    const placeholders = ids.map(() => "?").join(",");
    const memories = database.prepare(
      `SELECT memory_id, node_id, agent, category, content, summary, updated_at
       FROM memories WHERE node_id IN (${placeholders}) ORDER BY updated_at DESC`
    ).all(...ids) as any[];
    return memories;
  } catch {
    return []; // Table might not exist yet
  } finally {
    database.close();
  }
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
      const dbPath = getDbPath(process.cwd());
      const query = await getQueryModule();
      const result = await query.queryImpact({
        dbPath,
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      const summary = summarizeTraversal(result);
      const compact = compactifyTraversal(result);
      const memories = await fetchMemoriesForTraversal(dbPath, result);
      if (memories.length > 0) (compact as any).memories = memories;
      return { content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(compact) }] };
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
      const dbPath = getDbPath(process.cwd());
      const query = await getQueryModule();
      const result = await query.queryUpstream({
        dbPath,
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      const summary = summarizeTraversal(result);
      const compact = compactifyTraversal(result);
      const memories = await fetchMemoriesForTraversal(dbPath, result);
      if (memories.length > 0) (compact as any).memories = memories;
      return { content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(compact) }] };
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
      const dbPath = getDbPath(process.cwd());
      const query = await getQueryModule();
      const result = await query.queryDownstream({
        dbPath,
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      const summary = summarizeTraversal(result);
      const compact = compactifyTraversal(result);
      const memories = await fetchMemoriesForTraversal(dbPath, result);
      if (memories.length > 0) (compact as any).memories = memories;
      return { content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(compact) }] };
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
      const dbPath = getDbPath(process.cwd());
      const query = await getQueryModule();
      const result = await query.querySideEffects({
        dbPath,
        feature: GLOBAL_FEATURE,
        symbol,
        depth,
      });
      const summary = summarizeTraversal(result);
      const compact = compactifyTraversal(result);
      const memories = await fetchMemoriesForTraversal(dbPath, result);
      if (memories.length > 0) (compact as any).memories = memories;
      return { content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(compact) }] };
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

  // --- kk_search ---
  server.tool(
    "kk_search",
    `Search for nodes in the graph by name. Use this when you don't know the exact symbol name — search by partial name, file path, or keyword. Returns matching nodes with their kind, file, and line number.`,
    {
      term: z.string().describe("Search term — matches against symbol name, file path, or node ID"),
    },
    async ({ term }) => {
      const dbPath = getDbPath(process.cwd());
      const db = await getDbModule();
      try {
        await db.initGraphDb(dbPath);
        const database = db.openDatabase(dbPath);
        try {
          db.runMigrations(database);
          const pattern = `%${term}%`;
          const matches = database.prepare(`
            SELECT node_id, kind, symbol, file, line
            FROM nodes
            WHERE feature_name = ? AND (symbol LIKE ? OR file LIKE ? OR node_id LIKE ?)
            ORDER BY CASE WHEN symbol LIKE ? THEN 0 ELSE 1 END, kind, symbol
            LIMIT 50
          `).all(GLOBAL_FEATURE, pattern, pattern, pattern, pattern) as any[];

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "ok",
                term,
                count: matches.length,
                matches: matches.map((m) => ({ symbol: m.symbol, kind: m.kind, file: m.file, line: m.line })),
              }),
            }],
          };
        } finally {
          database.close();
        }
      } catch {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "No graph found. Run kk_init first." }) }] };
      }
    }
  );

  // --- kk_compare ---
  server.tool(
    "kk_compare",
    `Demonstrate the value of kk by comparing "with kk" vs "without kk" on this project. When the user asks to see if kk helps, call this tool — it will give you instructions to run a live side-by-side comparison.`,
    {
      symbol: z.string().optional().describe("A symbol to use for the comparison. If not provided, pick a server action or important function from the codebase."),
    },
    async ({ symbol }) => {
      const instructions = `## How to demonstrate kk value

Do this comparison live so the user sees real results from their own codebase.

### Part 1: WITHOUT kk

Pick the symbol "${symbol || "<pick a server action or important function>"}" and trace its dependencies using only grep and file reading:

1. Grep for the symbol name across the codebase
2. Read each file that references it
3. Follow imports from those files to find indirect dependencies
4. Keep count of: how many tool calls you made, how many files you read, how many references you found

Present your findings and be honest about what you're not sure about — indirect dependencies you might have missed, multi-hop chains you couldn't trace, etc.

### Part 2: WITH kk

Run these commands:
- \`kk impact ${symbol || "<symbol>"} --depth 3\`
- \`kk upstream ${symbol || "<symbol>"} --depth 2\`

### Part 3: Show the comparison

Present a clear side-by-side to the user:

\`\`\`
=== Tracing dependencies of ${symbol || "<symbol>"} ===

WITHOUT kk:
  Tool calls: [your actual count]
  Files read: [your actual count]
  References found: [your actual count]
  Confidence: [honest assessment — did you find everything?]

WITH kk:
  Tool calls: 1-2
  Files read: 0
  References found: [actual count from kk]
  Confidence: complete graph traversal

What kk found that I missed:
  [list specific connections kk found that grep didn't]
\`\`\`

The key point: it's not just about tokens — it's about completeness. Grep misses indirect dependencies, multi-hop chains, cross-workspace imports, and framework-specific connections (revalidation edges, table relationships).`;

      return { content: [{ type: "text", text: instructions }] };
    }
  );

  // --- kk_memory_write ---
  server.tool(
    "kk_memory_write",
    `Write a memory to the code graph. Memories persist across graph rebuilds and are surfaced automatically in impact/upstream queries.

Attach to a node (gotcha about a specific function), an edge, or nothing (global wiki entry).

Categories: "context" (general), "gotcha" (watch out), "decision" (why something was done this way), "warning" (fragile/dangerous), "wiki" (global knowledge).`,
    {
      content: z.string().describe("The memory content — what did you learn?"),
      summary: z.string().optional().describe("Short one-line summary for text search"),
      symbol: z.string().optional().describe("Symbol name to attach memory to (e.g. 'loginAction', 'users'). Resolved to node_id automatically."),
      node_id: z.string().optional().describe("Direct node ID to attach to (use symbol instead if you know the name)"),
      edge_id: z.string().optional().describe("Attach to a specific edge ID"),
      agent: z.string().optional().default("unknown").describe("Which agent is writing this (e.g. 'claude', 'codex', 'cursor')"),
      category: z.enum(["context", "gotcha", "decision", "warning", "wiki"]).optional().default("context").describe("Memory category"),
      commit_sha: z.string().optional().describe("Git commit SHA when this memory was created"),
    },
    async ({ content, summary, symbol, node_id, edge_id, agent, category, commit_sha }) => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const db = await getDbModule();
      await db.initGraphDb(dbPath);
      const database = db.openDatabase(dbPath);

      try {
        db.runMigrations(database);

        // Resolve symbol to node_id if symbol provided but node_id not
        let resolvedNodeId = node_id || null;
        if (!resolvedNodeId && symbol) {
          const resolved = await resolveSymbol(database, symbol);
          if (resolved.error) {
            return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: resolved.error }) }] };
          }
          resolvedNodeId = resolved.nodeId;
        }

        const memoryId = `mem-${randomUUID().slice(0, 12)}`;
        const now = new Date().toISOString();

        database.prepare(`
          INSERT INTO memories (memory_id, node_id, edge_id, agent, category, content, summary, commit_sha, created_at, updated_at)
          VALUES (@memory_id, @node_id, @edge_id, @agent, @category, @content, @summary, @commit_sha, @created_at, @updated_at)
        `).run({
          memory_id: memoryId,
          node_id: resolvedNodeId,
          edge_id: edge_id || null,
          agent: agent || "unknown",
          category: category || "context",
          content,
          summary: summary || null,
          commit_sha: commit_sha || null,
          created_at: now,
          updated_at: now,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "ok", memory_id: memoryId, node_id: resolvedNodeId, symbol: symbol || null, category }),
          }],
        };
      } finally {
        database.close();
      }
    }
  );

  // --- kk_memory_update ---
  server.tool(
    "kk_memory_update",
    `Update an existing memory. Only provided fields are updated — omit fields to keep their current value.`,
    {
      memory_id: z.string().describe("The memory ID to update"),
      content: z.string().optional().describe("New content"),
      summary: z.string().optional().describe("New summary"),
      category: z.enum(["context", "gotcha", "decision", "warning", "wiki"]).optional().describe("New category"),
      symbol: z.string().optional().describe("Change attached node by symbol name (resolved to node_id)"),
      node_id: z.string().optional().describe("Change attached node by direct node ID"),
      edge_id: z.string().optional().describe("Change attached edge"),
    },
    async ({ memory_id, content, summary, category, symbol, node_id, edge_id }) => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const db = await getDbModule();
      await db.initGraphDb(dbPath);
      const database = db.openDatabase(dbPath);

      try {
        db.runMigrations(database);

        const existing = database.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memory_id) as any;
        if (!existing) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: `Memory ${memory_id} not found` }) }] };
        }

        const updates: string[] = [];
        const params: any = { memory_id };

        if (content !== undefined) { updates.push("content = @content"); params.content = content; }
        if (summary !== undefined) { updates.push("summary = @summary"); params.summary = summary; }
        if (category !== undefined) { updates.push("category = @category"); params.category = category; }
        if (symbol !== undefined && node_id === undefined) {
          const resolved = await resolveSymbol(database, symbol);
          if (resolved.nodeId) { updates.push("node_id = @node_id"); params.node_id = resolved.nodeId; }
        }
        if (node_id !== undefined) { updates.push("node_id = @node_id"); params.node_id = node_id; }
        if (edge_id !== undefined) { updates.push("edge_id = @edge_id"); params.edge_id = edge_id; }

        if (updates.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "ok", memory_id, updated: false, message: "No fields to update" }) }] };
        }

        updates.push("updated_at = @updated_at");
        params.updated_at = new Date().toISOString();

        database.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE memory_id = @memory_id`).run(params);

        return { content: [{ type: "text", text: JSON.stringify({ status: "ok", memory_id, updated: true }) }] };
      } finally {
        database.close();
      }
    }
  );

  // --- kk_memory_read ---
  server.tool(
    "kk_memory_read",
    `Read memories attached to a symbol or node. Resolves symbol names to node IDs automatically. If no symbol provided, returns global/wiki memories.`,
    {
      symbol: z.string().optional().describe("Symbol name to read memories for (resolved to node IDs)"),
      node_id: z.string().optional().describe("Direct node ID to read memories for"),
      category: z.string().optional().describe("Filter by category"),
    },
    async ({ symbol, node_id, category }) => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const db = await getDbModule();
      await db.initGraphDb(dbPath);
      const database = db.openDatabase(dbPath);

      try {
        db.runMigrations(database);

        // Resolve symbol to node_ids
        const nodeIds: string[] = [];
        if (node_id) {
          nodeIds.push(node_id);
        } else if (symbol) {
          const resolved = await resolveSymbol(database, symbol);
          if (resolved.nodeId) {
            nodeIds.push(resolved.nodeId);
          }
          // If ambiguous or not found, return what we have (empty = global memories)
        }

        let memories: any[];
        if (nodeIds.length > 0) {
          const placeholders = nodeIds.map(() => "?").join(",");
          const catFilter = category ? " AND category = ?" : "";
          const params = [...nodeIds, ...(category ? [category] : [])];
          memories = database.prepare(
            `SELECT * FROM memories WHERE node_id IN (${placeholders})${catFilter} ORDER BY updated_at DESC`
          ).all(...params);

          // Also get edge memories touching these nodes
          const edgeMemories = database.prepare(
            `SELECT m.* FROM memories m JOIN edges e ON m.edge_id = e.edge_id AND e.feature_name = ?
             WHERE (e.from_node_id IN (${placeholders}) OR e.to_node_id IN (${placeholders}))${catFilter}
             ORDER BY m.updated_at DESC`
          ).all(GLOBAL_FEATURE, ...nodeIds, ...nodeIds, ...(category ? [category] : []));
          const seenIds = new Set(memories.map((m: any) => m.memory_id));
          for (const em of edgeMemories) {
            if (!seenIds.has((em as any).memory_id)) memories.push(em);
          }
        } else {
          // No symbol/node — return global memories
          const catFilter = category ? " AND category = ?" : "";
          memories = database.prepare(
            `SELECT * FROM memories WHERE node_id IS NULL AND edge_id IS NULL${catFilter} ORDER BY updated_at DESC LIMIT 50`
          ).all(...(category ? [category] : []));
        }

        // Check for stale memories (node no longer exists)
        for (const mem of memories) {
          if (mem.node_id) {
            const exists = database.prepare(
              "SELECT 1 FROM nodes WHERE feature_name = ? AND node_id = ? LIMIT 1"
            ).get(GLOBAL_FEATURE, mem.node_id);
            (mem as any).stale = !exists;
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              symbol: symbol || null,
              node_ids: nodeIds,
              count: memories.length,
              memories: memories.map((m: any) => ({
                memory_id: m.memory_id,
                node_id: m.node_id,
                edge_id: m.edge_id,
                agent: m.agent,
                category: m.category,
                content: m.content,
                summary: m.summary,
                commit_sha: m.commit_sha,
                stale: m.stale || false,
                created_at: m.created_at,
                updated_at: m.updated_at,
              })),
            }),
          }],
        };
      } finally {
        database.close();
      }
    }
  );

  // --- kk_memory_search ---
  server.tool(
    "kk_memory_search",
    `Full-text search across all agent memories. Use this to find memories by keyword — e.g. "permission", "billing", "race condition".`,
    {
      query: z.string().describe("Search query (keywords)"),
      category: z.string().optional().describe("Filter by category"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async ({ query, category, limit }) => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const db = await getDbModule();
      await db.initGraphDb(dbPath);
      const database = db.openDatabase(dbPath);

      try {
        db.runMigrations(database);

        // Add prefix matching: "migration" → "migration*" so it matches "migrations"
        const ftsQuery = query.trim().split(/\s+/).map((w) => `${w}*`).join(" ");
        const catFilter = category ? " AND m.category = ?" : "";
        const params: any[] = [ftsQuery, ...(category ? [category] : []), limit || 20];

        const results = database.prepare(`
          SELECT m.*, rank
          FROM memories_fts fts
          JOIN memories m ON m.rowid = fts.rowid
          WHERE memories_fts MATCH ?${catFilter}
          ORDER BY rank
          LIMIT ?
        `).all(...params) as any[];

        // Enrich with node info
        for (const r of results) {
          if (r.node_id) {
            const node = database.prepare(
              "SELECT symbol, kind, file FROM nodes WHERE feature_name = ? AND node_id = ?"
            ).get(GLOBAL_FEATURE, r.node_id) as any;
            r.node_symbol = node?.symbol || null;
            r.node_kind = node?.kind || null;
            r.node_file = node?.file || null;
            r.stale = !node;
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              query,
              count: results.length,
              memories: results.map((m: any) => ({
                memory_id: m.memory_id,
                node_id: m.node_id,
                node_symbol: m.node_symbol || null,
                node_kind: m.node_kind || null,
                node_file: m.node_file || null,
                agent: m.agent,
                category: m.category,
                content: m.content,
                summary: m.summary,
                stale: m.stale || false,
                updated_at: m.updated_at,
              })),
            }),
          }],
        };
      } finally {
        database.close();
      }
    }
  );

  // --- kk_memory_list ---
  server.tool(
    "kk_memory_list",
    `List all agent memories, optionally filtered by category or agent. Returns most recently updated first.`,
    {
      category: z.string().optional().describe("Filter by category (context, gotcha, decision, warning, wiki)"),
      agent: z.string().optional().describe("Filter by agent name (claude, codex, cursor, etc.)"),
      limit: z.number().optional().default(50).describe("Max results"),
    },
    async ({ category, agent, limit }) => {
      const cwd = process.cwd();
      const dbPath = getDbPath(cwd);
      const db = await getDbModule();
      await db.initGraphDb(dbPath);
      const database = db.openDatabase(dbPath);

      try {
        db.runMigrations(database);

        const filters: string[] = [];
        const params: any[] = [];
        if (category) { filters.push("category = ?"); params.push(category); }
        if (agent) { filters.push("agent = ?"); params.push(agent); }
        const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
        params.push(limit || 50);

        const memories = database.prepare(
          `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`
        ).all(...params) as any[];

        // Enrich with node info
        for (const m of memories) {
          if (m.node_id) {
            const node = database.prepare(
              "SELECT symbol, kind, file FROM nodes WHERE feature_name = ? AND node_id = ?"
            ).get(GLOBAL_FEATURE, m.node_id) as any;
            m.node_symbol = node?.symbol || null;
            m.node_kind = node?.kind || null;
            m.stale = !node;
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              count: memories.length,
              memories: memories.map((m: any) => ({
                memory_id: m.memory_id,
                node_id: m.node_id,
                node_symbol: m.node_symbol || null,
                node_kind: m.node_kind || null,
                edge_id: m.edge_id,
                agent: m.agent,
                category: m.category,
                content: m.content,
                summary: m.summary,
                stale: m.stale || false,
                created_at: m.created_at,
                updated_at: m.updated_at,
              })),
            }),
          }],
        };
      } finally {
        database.close();
      }
    }
  );

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
