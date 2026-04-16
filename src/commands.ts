import { randomUUID } from "node:crypto";
import path from "node:path";
import { getWorkingChanges } from "./git.js";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";
const GLOBAL_FEATURE = "__global__";
const DEFAULT_DEPTH = 4;

interface CommandFlags {
  json: boolean;
  depth: number;
  dbPath: string;
  symbol?: string;
  file?: string;
  from?: string;
  to?: string;
}

function parseCommandFlags(args: string[]): CommandFlags {
  const flags: CommandFlags = {
    json: false,
    depth: DEFAULT_DEPTH,
    dbPath: path.join(process.cwd(), DEFAULT_DB_PATH),
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { flags.json = true; continue; }
    if (arg === "--depth" && args[i + 1]) { flags.depth = parseInt(args[++i], 10) || DEFAULT_DEPTH; continue; }
    if (arg === "--db-path" && args[i + 1]) { flags.dbPath = args[++i]; continue; }
    if (arg === "--from" && args[i + 1]) { flags.from = args[++i]; continue; }
    if (arg === "--to" && args[i + 1]) { flags.to = args[++i]; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); }
  }

  // First positional arg is the symbol or file
  if (positional.length > 0) {
    const target = positional[0];
    // If it looks like a file path, treat as file
    if (target.includes("/") || target.includes(".ts") || target.includes(".tsx") || target.includes(".js")) {
      flags.file = target;
      // Extract symbol from filename for now
      flags.symbol = path.basename(target, path.extname(target));
    } else {
      flags.symbol = target;
    }
  }

  return flags;
}

async function getQueryModule() {
  return await import("./query.js");
}

/** Resolve a symbol name to a node_id using the same logic as kk impact/upstream. */
async function resolveSymbolToNodeId(database: any, symbol: string): Promise<string | null> {
  const query = await getQueryModule();
  const result = query.resolveNodeReference(database, GLOBAL_FEATURE, symbol);
  if (result.ok) return result.node.node_id;
  return null;
}

function emitResult(data: unknown, json: boolean, humanPrinter: (d: any) => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanPrinter(data);
  }
}

function printImpactHuman(result: any): void {
  const symbol = result.symbol;
  const starts = result.start_nodes || [];
  const impacts = result.impacts || result.upstreams || [];

  if (starts.length === 0) {
    console.log(`  No node found for symbol: ${symbol}`);
    return;
  }

  console.log("");
  for (const s of starts) {
    console.log(`  ${s.symbol} (${s.kind}) — ${s.file || ""}:${s.line || ""}`);
  }
  console.log("");

  if (impacts.length === 0) {
    console.log("  No downstream impacts found.");
    console.log("");
    return;
  }

  console.log(`  ${impacts.length} connections:`);
  const seen = new Set<string>();
  for (const i of impacts) {
    const from = i.from_symbol || i.from_node_id || "?";
    const to = i.to_symbol || i.to_node_id || "?";
    const key = `${from}→${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const conf = i.confidence_label ? ` [${i.confidence_label}]` : "";
    console.log(`    d=${i.depth} ${from} —${i.edge_type}→ ${to}${conf}`);
  }
  console.log("");
}

function printRiskHuman(result: any): void {
  if (result.status === "error") {
    console.error(`  ${result.message}`);
    return;
  }

  const changedFiles = result.changed_files || [];
  console.log("");
  console.log(`  Changed files: ${changedFiles.length}`);
  for (const f of changedFiles.slice(0, 10)) {
    console.log(`    ${f}`);
  }
  if (changedFiles.length > 10) {
    console.log(`    ... and ${changedFiles.length - 10} more`);
  }
  console.log("");

  const nodesAffected = result.impacted_nodes?.length || result.impact_count || 0;
  const sideEffects = result.side_effect_count || 0;
  const riskScore = result.risk_score ?? result.weighted_risk_score ?? "N/A";

  console.log(`  Nodes affected: ${nodesAffected}`);
  console.log(`  Side effects:   ${sideEffects}`);
  console.log(`  Risk score:     ${riskScore}`);
  console.log("");
}

// --- Simplified commands ---

export async function handleImpact(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);
  if (!flags.symbol) {
    console.error("Usage: kk impact <symbol> [--depth N] [--json]");
    return 1;
  }

  try {
    const query = await getQueryModule();
    const result = await query.queryImpact({
      dbPath: flags.dbPath,
      feature: GLOBAL_FEATURE,
      symbol: flags.symbol,
      depth: flags.depth,
    });
    emitResult(result, flags.json, printImpactHuman);
    return 0;
  } catch (err) {
    console.error(`Impact query failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleUpstream(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);
  if (!flags.symbol) {
    console.error("Usage: kk upstream <symbol> [--depth N] [--json]");
    return 1;
  }

  try {
    const query = await getQueryModule();
    const result = await query.queryUpstream({
      dbPath: flags.dbPath,
      feature: GLOBAL_FEATURE,
      symbol: flags.symbol,
      depth: flags.depth,
    });
    emitResult(result, flags.json, printImpactHuman);
    return 0;
  } catch (err) {
    console.error(`Upstream query failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleDownstream(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);
  if (!flags.symbol) {
    console.error("Usage: kk downstream <symbol> [--depth N] [--json]");
    return 1;
  }

  try {
    const query = await getQueryModule();
    const result = await query.queryDownstream({
      dbPath: flags.dbPath,
      feature: GLOBAL_FEATURE,
      symbol: flags.symbol,
      depth: flags.depth,
    });
    emitResult(result, flags.json, printImpactHuman);
    return 0;
  } catch (err) {
    console.error(`Downstream query failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleSideEffects(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);
  if (!flags.symbol) {
    console.error("Usage: kk side-effects <symbol> [--depth N] [--json]");
    return 1;
  }

  try {
    const query = await getQueryModule();
    const result = await query.querySideEffects({
      dbPath: flags.dbPath,
      feature: GLOBAL_FEATURE,
      symbol: flags.symbol,
      depth: flags.depth,
    });
    emitResult(result, flags.json, printImpactHuman);
    return 0;
  } catch (err) {
    console.error(`Side-effects query failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleWhy(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);
  if (!flags.from || !flags.to) {
    console.error("Usage: kk why --from <symbol> --to <symbol> [--depth N] [--json]");
    return 1;
  }

  try {
    const query = await getQueryModule();
    const result = await query.queryWhy({
      dbPath: flags.dbPath,
      feature: GLOBAL_FEATURE,
      from: flags.from,
      to: flags.to,
      depth: flags.depth,
    });
    emitResult(result, flags.json, (r) => {
      const paths = r.paths || r.explanation_paths || [];
      if (paths.length === 0) {
        console.log(`  No path found between ${flags.from} and ${flags.to}`);
        return;
      }
      console.log("");
      console.log(`  ${paths.length} path(s) found:`);
      for (const p of paths) {
        const steps = p.steps || p.edges || [];
        const chain = steps.map((s: any) => s.to_symbol || s.to_node_id).join(" → ");
        console.log(`    ${flags.from} → ${chain}`);
      }
      console.log("");
    });
    return 0;
  } catch (err) {
    console.error(`Why query failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleRisk(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);

  // Get changed files from git (unstaged + staged + untracked)
  const workingChanges = getWorkingChanges(process.cwd());
  const changedFiles = workingChanges.changedFiles;

  if (changedFiles.length === 0) {
    const result = { status: "ok", message: "No changed files detected.", risk_score: 0, changed_files: [] };
    emitResult(result, flags.json, () => console.log("  No changed files detected."));
    return 0;
  }

  // Find which graph nodes are in changed files and trace their impact
  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      // Find nodes in changed files
      const affectedNodes: any[] = [];
      for (const file of changedFiles) {
        const nodes = database.prepare(
          "SELECT node_id, kind, symbol, file FROM nodes WHERE feature_name = ? AND file LIKE ?"
        ).all(GLOBAL_FEATURE, `%${file}%`);
        affectedNodes.push(...nodes);
      }

      // Find downstream impact of affected nodes
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

      // Simple risk score: 0-100
      const nodeRatio = Math.min(affectedNodes.length / 20, 1); // up to 20 nodes = max
      const impactRatio = Math.min(totalImpact / 100, 1); // up to 100 impacts = max
      const sideEffectRatio = Math.min(sideEffectCount / 10, 1); // up to 10 side effects = max
      const riskScore = Math.round((nodeRatio * 0.3 + impactRatio * 0.4 + sideEffectRatio * 0.3) * 100);

      const riskLabel = riskScore >= 70 ? "high" : riskScore >= 40 ? "medium" : "low";

      const result = {
        status: "ok",
        changed_files: changedFiles,
        changed_file_count: changedFiles.length,
        affected_nodes: affectedNodes.length,
        downstream_impacts: totalImpact,
        side_effect_count: sideEffectCount,
        impacted_kinds: impactedKinds,
        risk_score: riskScore,
        risk_label: riskLabel,
      };

      emitResult(result, flags.json, (r) => {
        console.log("");
        console.log(`  Changed files: ${r.changed_file_count}`);
        for (const f of changedFiles.slice(0, 8)) {
          console.log(`    ${f}`);
        }
        if (changedFiles.length > 8) console.log(`    ... and ${changedFiles.length - 8} more`);
        console.log("");
        console.log(`  Affected nodes:      ${r.affected_nodes}`);
        console.log(`  Downstream impacts:  ${r.downstream_impacts}`);
        console.log(`  Side effects:        ${r.side_effect_count}`);
        console.log(`  Risk score:          ${r.risk_score}/100 (${r.risk_label})`);

        if (Object.keys(r.impacted_kinds).length > 0) {
          console.log("");
          console.log("  Impact by type:");
          for (const [kind, count] of Object.entries(r.impacted_kinds).sort((a, b) => (b[1] as number) - (a[1] as number))) {
            console.log(`    ${kind}: ${count}`);
          }
        }
        console.log("");
      });

      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Risk analysis failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleStatus(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

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
      ).all(GLOBAL_FEATURE) as Array<{ kind: string; cnt: number }>;

      const edgeTypes = database.prepare(
        "SELECT edge_type, COUNT(*) as cnt FROM edges WHERE feature_name = ? GROUP BY edge_type ORDER BY cnt DESC"
      ).all(GLOBAL_FEATURE) as Array<{ edge_type: string; cnt: number }>;

      // Get last build info
      const lastBuild = database.prepare(
        "SELECT build_id, created_at, trigger_details_json FROM builds WHERE feature_name = ? ORDER BY created_at DESC LIMIT 1"
      ).get(GLOBAL_FEATURE) as any;

      let gitSha: string | null = null;
      try {
        gitSha = (database.prepare("SELECT value FROM kv WHERE key = 'last_build_sha'").get() as any)?.value;
      } catch { /* no kv table */ }

      const result = {
        status: "ok",
        db_path: flags.dbPath,
        nodes: nodeCount,
        edges: edgeCount,
        nodes_by_kind: Object.fromEntries(nodeKinds.map((r) => [r.kind, r.cnt])),
        edges_by_type: Object.fromEntries(edgeTypes.map((r) => [r.edge_type, r.cnt])),
        last_build: lastBuild ? {
          build_id: lastBuild.build_id,
          created_at: lastBuild.created_at,
          git_sha: gitSha,
        } : null,
      };

      emitResult(result, flags.json, (r) => {
        console.log("");
        console.log(`  Graph: ${r.nodes} nodes, ${r.edges} edges`);
        if (r.last_build) {
          console.log(`  Last build: ${r.last_build.created_at}${r.last_build.git_sha ? ` (${r.last_build.git_sha.slice(0, 7)})` : ""}`);
        }
        console.log("");
        console.log("  Nodes:");
        for (const [kind, cnt] of Object.entries(r.nodes_by_kind)) {
          console.log(`    ${kind}: ${cnt}`);
        }
        console.log("");
        console.log("  Edges:");
        for (const [type, cnt] of Object.entries(r.edges_by_type)) {
          console.log(`    ${type}: ${cnt}`);
        }
        console.log("");
      });

      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Status failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

export async function handleSearch(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);
  const term = flags.symbol;

  if (!term) {
    console.error("Usage: kk search <term> [--json]");
    return 1;
  }

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      const pattern = `%${term}%`;
      const matches = database.prepare(`
        SELECT node_id, kind, symbol, file, line
        FROM nodes
        WHERE feature_name = ? AND (symbol LIKE ? OR file LIKE ? OR node_id LIKE ?)
        ORDER BY
          CASE WHEN symbol LIKE ? THEN 0 ELSE 1 END,
          kind, symbol
        LIMIT 50
      `).all(GLOBAL_FEATURE, pattern, pattern, pattern, pattern) as Array<{
        node_id: string; kind: string; symbol: string; file: string; line: number;
      }>;

      const result = {
        status: "ok",
        term,
        count: matches.length,
        matches: matches.map((m) => ({
          symbol: m.symbol,
          kind: m.kind,
          file: m.file,
          line: m.line,
          node_id: m.node_id,
        })),
      };

      emitResult(result, flags.json, (r) => {
        if (r.count === 0) {
          console.log(`  No nodes matching "${term}"`);
          return;
        }
        console.log("");
        console.log(`  ${r.count} matches for "${term}":`);
        console.log("");
        for (const m of r.matches) {
          console.log(`    ${m.symbol.padEnd(35)} ${m.kind.padEnd(18)} ${m.file}:${m.line}`);
        }
        console.log("");
      });

      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Search failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

// --- Precommit command ---

export async function handlePrecommit(args: string[]): Promise<number> {
  const flags = parseCommandFlags(args);

  try {
    const { reviewGraph } = await import("./review-graph.js");
    const result = await reviewGraph(process.cwd());

    emitResult(result, flags.json, (r) => {
      if (r.message && r.stats.total_changed_files === 0) {
        console.log(`  ${r.message}`);
        return;
      }

      console.log("");
      console.log(`  Changed files: ${r.stats.total_changed_files}`);
      console.log("");

      // New symbols
      if (r.new_symbols.length > 0) {
        console.log("  new_symbols:");
        for (const s of r.new_symbols) {
          console.log(`    ${s.symbol} (${s.kind}) — ${s.file}:${s.line}`);
        }
        console.log("");
      }

      // New edges
      if (r.new_edges.length > 0) {
        console.log("  new_edges:");
        for (const e of r.new_edges) {
          console.log(`    ${e.from_symbol} → ${e.to_symbol} (${e.edge_type})`);
        }
        console.log("");
      }

      // Orphans
      if (r.orphans.length > 0) {
        console.log("  orphans:");
        for (const o of r.orphans) {
          console.log(`    \u26A0 ${o.symbol} (${o.kind}) — not called from any existing code path`);
          if (o.suggestion) console.log(`      \u2192 ${o.suggestion}`);
        }
        console.log("");
      }

      // Tables touched
      if (r.tables_touched.writes.length > 0 || r.tables_touched.reads.length > 0) {
        console.log("  tables_touched:");
        if (r.tables_touched.writes.length > 0) {
          console.log(`    WRITES: ${r.tables_touched.writes.join(", ")}`);
        }
        if (r.tables_touched.reads.length > 0) {
          console.log(`    READS:  ${r.tables_touched.reads.join(", ")}`);
        }
        console.log("");
      }

      // Breaking changes
      if (r.breaking_changes.length > 0) {
        console.log("  breaking_changes:");
        for (const b of r.breaking_changes) {
          console.log(`    ${b.symbol} (${b.kind}) — ${b.note}`);
        }
        console.log("");
      }

      // Missing coverage
      if (r.missing_coverage.length > 0) {
        console.log("  missing_coverage:");
        for (const m of r.missing_coverage) {
          console.log(`    ? ${m}`);
        }
        console.log("");
      }
    });

    return 0;
  } catch (err) {
    console.error(`Precommit analysis failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

// --- Memory commands ---

interface MemoryFlags {
  json: boolean;
  dbPath: string;
  node?: string;
  category?: string;
  summary?: string;
  agent?: string;
  content?: string;
  memoryId?: string;
  limit: number;
}

function parseMemoryFlags(args: string[]): MemoryFlags {
  const flags: MemoryFlags = {
    json: false,
    dbPath: path.join(process.cwd(), DEFAULT_DB_PATH),
    limit: 50,
  };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { flags.json = true; continue; }
    if (arg === "--db-path" && args[i + 1]) { flags.dbPath = args[++i]; continue; }
    if (arg === "--node" && args[i + 1]) { flags.node = args[++i]; continue; }
    if (arg === "--category" && args[i + 1]) { flags.category = args[++i]; continue; }
    if (arg === "--summary" && args[i + 1]) { flags.summary = args[++i]; continue; }
    if (arg === "--agent" && args[i + 1]) { flags.agent = args[++i]; continue; }
    if (arg === "--content" && args[i + 1]) { flags.content = args[++i]; continue; }
    if (arg === "--limit" && args[i + 1]) { flags.limit = parseInt(args[++i], 10) || 50; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); }
  }

  // First positional is content for write, query for search, memory_id for update
  if (positional.length > 0) flags.content = positional[0];
  if (positional.length > 1) flags.memoryId = positional[0]; // for update: first is id, second is content

  return flags;
}

export async function handleMemory(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "help") {
    console.log(`
kk memory — Agent memory system

Usage:
  kk memory write <content> [--node <symbol>] [--category <cat>] [--summary <text>] [--agent <name>]
  kk memory update <memory_id> [--content <text>] [--summary <text>] [--category <cat>]
  kk memory read [--node <symbol>] [--category <cat>]
  kk memory search <query> [--category <cat>] [--limit N]
  kk memory list [--category <cat>] [--agent <name>] [--limit N]

Categories: context, gotcha, decision, warning, wiki
`);
    return 0;
  }

  if (subcommand === "write") return handleMemoryWrite(rest);
  if (subcommand === "update") return handleMemoryUpdate(rest);
  if (subcommand === "read") return handleMemoryRead(rest);
  if (subcommand === "search") return handleMemorySearch(rest);
  if (subcommand === "list") return handleMemoryList(rest);

  console.error(`Unknown memory subcommand: ${subcommand}`);
  return 1;
}

async function handleMemoryWrite(args: string[]): Promise<number> {
  const flags = parseMemoryFlags(args);
  if (!flags.content) {
    console.error("Usage: kk memory write <content> [--node <symbol>] [--category <cat>]");
    return 1;
  }

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      // Resolve --node symbol to node_id
      let nodeId: string | null = null;
      if (flags.node) {
        nodeId = await resolveSymbolToNodeId(database, flags.node);
        if (!nodeId) {
          console.error(`Warning: No node found for symbol "${flags.node}" — saving as global memory`);
        }
      }

      const memoryId = `mem-${randomUUID().slice(0, 12)}`;
      const now = new Date().toISOString();

      database.prepare(`
        INSERT INTO memories (memory_id, node_id, edge_id, agent, category, content, summary, commit_sha, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)
      `).run(memoryId, nodeId, flags.agent || "cli", flags.category || "context", flags.content, flags.summary || null, now, now);

      const result = { status: "ok", memory_id: memoryId, node_id: nodeId, category: flags.category || "context" };
      emitResult(result, flags.json, (r) => {
        console.log(`  Memory saved: ${r.memory_id}${r.node_id ? ` → ${r.node_id}` : " (global)"}`);
      });
      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Memory write failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

async function handleMemoryUpdate(args: string[]): Promise<number> {
  const flags = parseMemoryFlags(args);
  const memoryId = flags.content; // first positional arg is memory_id for update
  if (!memoryId) {
    console.error("Usage: kk memory update <memory_id> [--content <text>] [--summary <text>] [--category <cat>]");
    return 1;
  }

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      const existing = database.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId);
      if (!existing) {
        console.error(`Memory ${memoryId} not found`);
        return 1;
      }

      const updates: string[] = [];
      const params: any[] = [];

      // For update, --content flag is the new content (not positional)
      const newContent = args.find((a, i) => args[i - 1] === "--content");
      if (newContent) { updates.push("content = ?"); params.push(newContent); }
      if (flags.summary) { updates.push("summary = ?"); params.push(flags.summary); }
      if (flags.category) { updates.push("category = ?"); params.push(flags.category); }

      if (updates.length === 0) {
        console.error("No fields to update. Use --content, --summary, or --category.");
        return 1;
      }

      updates.push("updated_at = ?");
      params.push(new Date().toISOString());
      params.push(memoryId);

      database.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE memory_id = ?`).run(...params);

      const result = { status: "ok", memory_id: memoryId, updated: true };
      emitResult(result, flags.json, () => console.log(`  Memory updated: ${memoryId}`));
      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Memory update failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

async function handleMemoryRead(args: string[]): Promise<number> {
  const flags = parseMemoryFlags(args);

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      let memories: any[];
      if (flags.node) {
        const resolvedId = await resolveSymbolToNodeId(database, flags.node);
        if (!resolvedId) {
          console.log(`  No nodes matching "${flags.node}"`);
          return 0;
        }
        const nodeIds = [resolvedId];
        const placeholders = nodeIds.map(() => "?").join(",");
        const catFilter = flags.category ? " AND category = ?" : "";
        memories = database.prepare(
          `SELECT * FROM memories WHERE node_id IN (${placeholders})${catFilter} ORDER BY updated_at DESC`
        ).all(...nodeIds, ...(flags.category ? [flags.category] : []));
      } else {
        // Global memories
        const catFilter = flags.category ? " AND category = ?" : "";
        memories = database.prepare(
          `SELECT * FROM memories WHERE node_id IS NULL AND edge_id IS NULL${catFilter} ORDER BY updated_at DESC LIMIT ?`
        ).all(...(flags.category ? [flags.category] : []), flags.limit);
      }

      const result = { status: "ok", count: memories.length, memories };
      emitResult(result, flags.json, (r) => {
        if (r.count === 0) {
          console.log("  No memories found.");
          return;
        }
        console.log("");
        for (const m of r.memories) {
          const tag = m.node_id ? `[${m.category}] → ${m.node_id}` : `[${m.category}] (global)`;
          console.log(`  ${m.memory_id}  ${tag}`);
          console.log(`    ${m.content}`);
          if (m.summary) console.log(`    Summary: ${m.summary}`);
          console.log(`    Agent: ${m.agent} | Updated: ${m.updated_at}`);
          console.log("");
        }
      });
      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Memory read failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

async function handleMemorySearch(args: string[]): Promise<number> {
  const flags = parseMemoryFlags(args);
  const query = flags.content; // first positional is the search query
  if (!query) {
    console.error("Usage: kk memory search <query> [--category <cat>] [--limit N]");
    return 1;
  }

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      // Add prefix matching: "migration" → "migration*" so it matches "migrations"
      const ftsQuery = query.trim().split(/\s+/).map((w: string) => `${w}*`).join(" ");
      const catFilter = flags.category ? " AND m.category = ?" : "";
      const params: any[] = [ftsQuery, ...(flags.category ? [flags.category] : []), flags.limit];

      const results = database.prepare(`
        SELECT m.*, rank
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?${catFilter}
        ORDER BY rank
        LIMIT ?
      `).all(...params) as any[];

      const result = { status: "ok", query, count: results.length, memories: results };
      emitResult(result, flags.json, (r) => {
        if (r.count === 0) {
          console.log(`  No memories matching "${query}"`);
          return;
        }
        console.log("");
        console.log(`  ${r.count} memories matching "${query}":`);
        console.log("");
        for (const m of r.memories) {
          const tag = m.node_id ? `→ ${m.node_id}` : "(global)";
          console.log(`  ${m.memory_id}  [${m.category}] ${tag}`);
          console.log(`    ${m.content}`);
          console.log("");
        }
      });
      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Memory search failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

async function handleMemoryList(args: string[]): Promise<number> {
  const flags = parseMemoryFlags(args);

  try {
    const db = await import("./db.js");
    await db.initGraphDb(flags.dbPath);
    const database = db.openDatabase(flags.dbPath);

    try {
      db.runMigrations(database);

      const filters: string[] = [];
      const params: any[] = [];
      if (flags.category) { filters.push("category = ?"); params.push(flags.category); }
      if (flags.agent) { filters.push("agent = ?"); params.push(flags.agent); }
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      params.push(flags.limit);

      const memories = database.prepare(
        `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`
      ).all(...params) as any[];

      const result = { status: "ok", count: memories.length, memories };
      emitResult(result, flags.json, (r) => {
        if (r.count === 0) {
          console.log("  No memories found.");
          return;
        }
        console.log("");
        console.log(`  ${r.count} memories:`);
        console.log("");
        for (const m of r.memories) {
          const tag = m.node_id ? `→ ${m.node_id}` : "(global)";
          console.log(`  ${m.memory_id}  [${m.category}] ${tag}  (${m.agent})`);
          console.log(`    ${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}`);
          console.log("");
        }
      });
      return 0;
    } finally {
      database.close();
    }
  } catch (err) {
    console.error(`Memory list failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}
