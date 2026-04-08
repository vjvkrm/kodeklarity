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
