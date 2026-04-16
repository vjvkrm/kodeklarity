import path from "node:path";
import { discover } from "./discover/index.js";
import { traceImportEdges } from "./trace.js";
import { traceWithTypeChecker } from "./type-tracer.js";
import { loadConfig } from "./config.js";
import { getWorkingChanges } from "./git.js";
import type { BoundaryNode, BoundaryEdge } from "./discover/types.js";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";
const GLOBAL_FEATURE = "__global__";

export interface ReviewGraphResult {
  status: "ok" | "error";
  message?: string;

  /** Files with uncommitted changes (staged + unstaged + untracked) */
  changed_files: string[];

  /** New boundary nodes discovered in changed files */
  new_symbols: Array<{
    symbol: string;
    kind: string;
    file: string;
    line: number;
  }>;

  /** New edges from/to changed nodes */
  new_edges: Array<{
    from_symbol: string;
    to_symbol: string;
    edge_type: string;
    file: string;
  }>;

  /** New nodes with no incoming edges from the full graph — nobody calls them yet */
  orphans: Array<{
    symbol: string;
    kind: string;
    file: string;
    suggestion?: string;
  }>;

  /** Tables referenced by changed code, grouped by read/write */
  tables_touched: {
    writes: string[];
    reads: string[];
  };

  /** Existing nodes in modified files — potential breaking changes */
  breaking_changes: Array<{
    symbol: string;
    kind: string;
    file: string;
    downstream_count: number;
    note: string;
  }>;

  /** Missing coverage signals */
  missing_coverage: string[];

  /** Summary stats */
  stats: {
    total_changed_files: number;
    new_node_count: number;
    new_edge_count: number;
    orphan_count: number;
    tables_write_count: number;
    tables_read_count: number;
    breaking_change_count: number;
  };
}

/**
 * Run review-graph: discover the working tree, diff against the committed graph,
 * report new symbols, orphans, tables touched, and breaking changes.
 * Nothing is persisted — purely in-memory analysis.
 */
export async function reviewGraph(cwd: string): Promise<ReviewGraphResult> {
  const dbPath = path.join(cwd, DEFAULT_DB_PATH);

  // 1. Get changed files from git working tree
  const workingChanges = getWorkingChanges(cwd);
  const changedFiles = workingChanges.changedFiles;
  const deletedFiles = new Set(workingChanges.deletedFiles);

  if (changedFiles.length === 0 && deletedFiles.size === 0) {
    return {
      status: "ok",
      message: "No uncommitted changes detected.",
      changed_files: [],
      new_symbols: [],
      new_edges: [],
      orphans: [],
      tables_touched: { writes: [], reads: [] },
      breaking_changes: [],
      missing_coverage: [],
      stats: {
        total_changed_files: 0,
        new_node_count: 0,
        new_edge_count: 0,
        orphan_count: 0,
        tables_write_count: 0,
        tables_read_count: 0,
        breaking_change_count: 0,
      },
    };
  }

  // Filter to TS/JS files that matter for the graph
  const relevantExtensions = [".ts", ".tsx", ".js", ".jsx"];
  const changedTsFiles = new Set(
    changedFiles.filter((f) => relevantExtensions.some((ext) => f.endsWith(ext)))
  );

  // 2. Run full discovery on the working tree (reads actual files on disk, so sees uncommitted changes)
  const config = await loadConfig(cwd);
  const freshResult = await discover(cwd, config ?? undefined);

  // 3. Run tracers to find edges
  if (freshResult.nodes.length > 0) {
    const depth = config?.trace?.maxDepth ?? 4;
    const typeResult = await traceWithTypeChecker({ repoRoot: cwd, nodes: freshResult.nodes, maxDepth: depth });
    freshResult.edges.push(...typeResult.edges);

    const importResult = await traceImportEdges({ repoRoot: cwd, nodes: freshResult.nodes, maxDepth: depth });
    const seen = new Set(freshResult.edges.map((e) => `${e.from}→${e.to}`));
    for (const edge of importResult.edges) {
      if (!seen.has(`${edge.from}→${edge.to}`)) freshResult.edges.push(edge);
    }
  }

  // 4. Load existing committed graph from DB
  const existingNodes = new Map<string, { node_id: string; kind: string; symbol: string; file: string; line: number }>();
  const existingEdges = new Map<string, { from_node_id: string; to_node_id: string; edge_type: string; file: string }>();

  try {
    const db = await import("./db.js");
    const database = db.openDatabase(dbPath);
    try {
      const nodes = database.prepare(
        "SELECT node_id, kind, symbol, file, line FROM nodes WHERE feature_name = ?"
      ).all(GLOBAL_FEATURE) as Array<{ node_id: string; kind: string; symbol: string; file: string; line: number }>;
      for (const n of nodes) existingNodes.set(n.node_id, n);

      const edges = database.prepare(
        "SELECT edge_id, from_node_id, to_node_id, edge_type, file FROM edges WHERE feature_name = ?"
      ).all(GLOBAL_FEATURE) as Array<{ edge_id: string; from_node_id: string; to_node_id: string; edge_type: string; file: string }>;
      for (const e of edges) existingEdges.set(`${e.from_node_id}→${e.to_node_id}`, e);
    } finally {
      database.close();
    }
  } catch {
    // No existing graph — everything is new. That's fine.
  }

  // Build lookup maps for fresh discovery
  const freshNodeMap = new Map<string, BoundaryNode>();
  for (const n of freshResult.nodes) freshNodeMap.set(n.id, n);

  const freshEdgeSet = new Set<string>();
  for (const e of freshResult.edges) freshEdgeSet.add(`${e.from}→${e.to}`);

  // 5. Compute diffs

  // New symbols: nodes in fresh that don't exist in committed graph AND are in changed files
  const newSymbols: ReviewGraphResult["new_symbols"] = [];
  const newNodeIds = new Set<string>();
  for (const node of freshResult.nodes) {
    if (!existingNodes.has(node.id) && changedTsFiles.has(node.file)) {
      newSymbols.push({ symbol: node.symbol, kind: node.kind, file: node.file, line: node.line });
      newNodeIds.add(node.id);
    }
  }

  // New edges: edges in fresh that don't exist in committed graph, involving changed nodes
  const newEdges: ReviewGraphResult["new_edges"] = [];
  for (const edge of freshResult.edges) {
    const key = `${edge.from}→${edge.to}`;
    if (!existingEdges.has(key)) {
      const fromNode = freshNodeMap.get(edge.from);
      const toNode = freshNodeMap.get(edge.to);
      // Only include if at least one end is in a changed file
      if (
        (fromNode && changedTsFiles.has(fromNode.file)) ||
        (toNode && changedTsFiles.has(toNode.file))
      ) {
        newEdges.push({
          from_symbol: fromNode?.symbol || edge.from,
          to_symbol: toNode?.symbol || edge.to,
          edge_type: edge.edgeType,
          file: edge.file,
        });
      }
    }
  }

  // 6. Orphan detection: new nodes with 0 incoming edges in the merged graph
  // An orphan is a new node that nothing else calls/imports
  const allIncomingTargets = new Map<string, number>();
  // Count incoming edges from ALL edges (existing + fresh)
  for (const [, e] of existingEdges) {
    allIncomingTargets.set(e.to_node_id, (allIncomingTargets.get(e.to_node_id) || 0) + 1);
  }
  for (const e of freshResult.edges) {
    allIncomingTargets.set(e.to, (allIncomingTargets.get(e.to) || 0) + 1);
  }

  const orphans: ReviewGraphResult["orphans"] = [];
  for (const node of freshResult.nodes) {
    if (!newNodeIds.has(node.id)) continue; // only check new nodes
    const incomingCount = allIncomingTargets.get(node.id) || 0;
    if (incomingCount === 0) {
      // Find a potential wiring suggestion: look for existing nodes of similar kind
      let suggestion: string | undefined;
      if (node.kind === "service" || node.kind === "server_action") {
        // Suggest connecting to a route or job
        for (const [, existing] of existingNodes) {
          if (existing.kind === "route" || existing.kind === "api_route" || existing.kind === "background_job") {
            suggestion = `wire into ${existing.symbol}?`;
            break;
          }
        }
      }
      orphans.push({ symbol: node.symbol, kind: node.kind, file: node.file, suggestion });
    }
  }

  // 7. Tables touched: find table-related edges from changed nodes
  const WRITE_EDGE_TYPES = new Set(["uses_table", "writes_table"]);
  const READ_EDGE_TYPES = new Set(["reads_table", "queries_data"]);
  const tablesWritten = new Set<string>();
  const tablesRead = new Set<string>();

  for (const edge of freshResult.edges) {
    const fromNode = freshNodeMap.get(edge.from);
    if (!fromNode || !changedTsFiles.has(fromNode.file)) continue;

    const toNode = freshNodeMap.get(edge.to);
    if (!toNode) continue;

    if (toNode.kind === "table") {
      if (WRITE_EDGE_TYPES.has(edge.edgeType)) {
        tablesWritten.add(toNode.symbol);
      } else if (READ_EDGE_TYPES.has(edge.edgeType)) {
        tablesRead.add(toNode.symbol);
      } else {
        // Generic table reference — count as read
        tablesRead.add(toNode.symbol);
      }
    }
  }

  // 8. Breaking changes: existing nodes whose files were modified
  const breakingChanges: ReviewGraphResult["breaking_changes"] = [];
  for (const [nodeId, existing] of existingNodes) {
    if (!changedTsFiles.has(existing.file)) continue;
    // This existing node's file was modified — check how many things depend on it
    let downstreamCount = 0;
    for (const [, e] of existingEdges) {
      if (e.from_node_id === nodeId) downstreamCount++;
    }
    // Also check fresh edges for downstream
    for (const e of freshResult.edges) {
      if (e.from === nodeId) downstreamCount++;
    }

    // Only flag if it has downstream dependents
    if (downstreamCount > 0) {
      // Check if node still exists in fresh (not deleted/renamed)
      const stillExists = freshNodeMap.has(nodeId);
      const note = stillExists
        ? `modified — ${downstreamCount} downstream dependents`
        : `removed or renamed — ${downstreamCount} downstream dependents (check callers)`;

      breakingChanges.push({
        symbol: existing.symbol,
        kind: existing.kind,
        file: existing.file,
        downstream_count: downstreamCount,
        note,
      });
    }
  }

  // 9. Missing coverage signals
  const missingCoverage: string[] = [];

  // Check for new files not covered by any adapter
  for (const file of changedTsFiles) {
    const hasNode = freshResult.nodes.some((n) => n.file === file);
    if (!hasNode && !file.includes("test") && !file.includes("spec") && !file.includes(".d.ts")) {
      // File has no boundary nodes — might need customBoundaries config
      const dir = path.dirname(file);
      missingCoverage.push(`${file} — no boundary nodes detected (add to customBoundaries?)`);
    }
  }

  // Check if new nodes have test files
  for (const sym of newSymbols) {
    const testFile = sym.file.replace(/\.tsx?$/, ".test.ts");
    const specFile = sym.file.replace(/\.tsx?$/, ".spec.ts");
    const hasTest = changedFiles.includes(testFile) || changedFiles.includes(specFile);
    if (!hasTest && sym.kind !== "table") {
      missingCoverage.push(`${sym.symbol} (${sym.kind}) — no test file`);
    }
  }

  return {
    status: "ok",
    changed_files: changedFiles,
    new_symbols: newSymbols,
    new_edges: newEdges,
    orphans,
    tables_touched: {
      writes: [...tablesWritten].sort(),
      reads: [...tablesRead].sort(),
    },
    breaking_changes: breakingChanges,
    missing_coverage: missingCoverage,
    stats: {
      total_changed_files: changedFiles.length,
      new_node_count: newSymbols.length,
      new_edge_count: newEdges.length,
      orphan_count: orphans.length,
      tables_write_count: tablesWritten.size,
      tables_read_count: tablesRead.size,
      breaking_change_count: breakingChanges.length,
    },
  };
}
