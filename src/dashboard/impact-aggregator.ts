import path from "node:path";
import { reviewGraph } from "../review-graph.js";
import { loadConfig } from "../config.js";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";
const GLOBAL_FEATURE = "__global__";

export interface DashboardNode {
  node_id: string;
  symbol: string;
  kind: string;
  file: string;
  line: number;
  changed: boolean;
}

export interface DashboardEdge {
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  file: string | null;
  line: number | null;
}

export interface DashboardChangedFile {
  file: string;
  tracked: boolean;
  /** Whether this file is the kind kk expects to have boundary nodes (TS/JS source, non-test). */
  relevant: boolean;
  /** True when matched by config.ignoreCoverage — silenced from the missing-coverage CTA. */
  ignored: boolean;
}

/**
 * Mirror of the filter in src/review-graph.ts that decides whether a changed file
 * should appear in `missing_coverage`. Keep the two in sync; if review-graph's
 * rule changes, change here too.
 */
function isRelevantSource(file: string): boolean {
  if (!/\.(ts|tsx|js|jsx)$/.test(file)) return false;
  if (file.endsWith(".d.ts")) return false;
  // matches the existing review-graph rule: filename or path containing "test" / "spec"
  if (/(^|\/)(__tests__|__mocks__)\//.test(file)) return false;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)) return false;
  // Build/config TS that is never a boundary
  if (/(^|\/)(vite|tsup|rollup|webpack|jest|vitest|playwright)\.config\.(ts|js)$/.test(file)) return false;
  if (/(^|\/)tsconfig(\..+)?\.json$/.test(file)) return false;
  return true;
}

export interface CoverageAction {
  files: string[];
  next_steps: string[];
  example_boundary: {
    name: string;
    kind: string;
    glob: string;
    symbolPattern: string;
    reason: string;
  };
}

export interface ImpactResponse {
  status: "ok";
  cwd: string;
  changedFiles: DashboardChangedFile[];
  changedNodeIds: string[];
  nodes: DashboardNode[];
  edges: DashboardEdge[];
  coverageAction: CoverageAction | null;
  stats: {
    changedCount: number;
    neighborCount: number;
    edgeCount: number;
  };
}

export interface PrecommitResponse {
  status: "ok";
  cwd: string;
  changedFiles: DashboardChangedFile[];
  changedNodeIds: string[];
  nodes: DashboardNode[];
  edges: DashboardEdge[];
  raw: unknown;
  coverageAction: CoverageAction | null;
  stats: {
    changedCount: number;
    edgeCount: number;
  };
}

interface ReviewLite {
  changed_files: string[];
  touched_node_ids: string[];
  new_symbols: Array<{ symbol: string; kind: string; file: string; line: number }>;
  new_edges: Array<{ from_symbol: string; to_symbol: string; edge_type: string; file: string }>;
  coverage_action: CoverageAction | null;
  raw: unknown;
}

async function runReview(cwd: string): Promise<ReviewLite> {
  const result = await reviewGraph(cwd);
  return {
    changed_files: result.changed_files ?? [],
    touched_node_ids: result.touched_node_ids ?? [],
    new_symbols: result.new_symbols ?? [],
    new_edges: result.new_edges ?? [],
    coverage_action: (result as any).coverage_action ?? null,
    raw: result,
  };
}

interface DbModule {
  initGraphDb: (dbPath: string) => Promise<void>;
  openDatabase: (dbPath: string) => any;
  runMigrations: (db: any) => void;
}

async function getDbModule(): Promise<DbModule> {
  return (await import("../db.js")) as unknown as DbModule;
}

function buildNewNodes(reviewResult: ReviewLite): DashboardNode[] {
  return reviewResult.new_symbols.map((s) => ({
    node_id: `__new__:${s.file}:${s.symbol}`,
    symbol: s.symbol,
    kind: s.kind,
    file: s.file,
    line: s.line,
    changed: true,
  }));
}

function buildNewEdges(reviewResult: ReviewLite, nodes: DashboardNode[]): DashboardEdge[] {
  const symbolToId = new Map<string, string>();
  for (const n of nodes) {
    if (!symbolToId.has(n.symbol)) symbolToId.set(n.symbol, n.node_id);
  }
  const edges: DashboardEdge[] = [];
  for (const e of reviewResult.new_edges) {
    const from = symbolToId.get(e.from_symbol);
    const to = symbolToId.get(e.to_symbol);
    if (!from || !to) continue;
    edges.push({
      from_node_id: from,
      to_node_id: to,
      edge_type: e.edge_type,
      file: e.file ?? null,
      line: null,
    });
  }
  return edges;
}

function annotateChangedFiles(
  reviewResult: ReviewLite,
  nodes: DashboardNode[],
  ignorePatterns: string[],
): DashboardChangedFile[] {
  const trackedFiles = new Set(nodes.filter((n) => n.changed).map((n) => n.file));
  const isIgnored = (f: string) => ignorePatterns.some((p) => path.matchesGlob(f, p));
  return reviewResult.changed_files.map((file) => ({
    file,
    tracked: trackedFiles.has(file),
    relevant: isRelevantSource(file),
    ignored: isIgnored(file),
  }));
}

async function loadIgnorePatterns(cwd: string): Promise<string[]> {
  const config = await loadConfig(cwd);
  return config?.ignoreCoverage ?? [];
}

/**
 * Precommit: closed set — only nodes/edges that come from the diff itself.
 * Combines existing touched nodes (from db) and newly-discovered symbols (from review).
 */
export async function buildPrecommitGraph(cwd: string): Promise<PrecommitResponse> {
  const dbPath = path.join(cwd, DEFAULT_DB_PATH);
  const [review, ignorePatterns] = await Promise.all([runReview(cwd), loadIgnorePatterns(cwd)]);
  const { initGraphDb, openDatabase, runMigrations } = await getDbModule();

  let existingNodes: DashboardNode[] = [];
  let existingEdges: DashboardEdge[] = [];

  if (review.touched_node_ids.length > 0) {
    await initGraphDb(dbPath);
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      const placeholders = review.touched_node_ids.map(() => "?").join(",");
      existingNodes = (
        db
          .prepare(
            `SELECT node_id, symbol, kind, file, line FROM nodes WHERE feature_name = ? AND node_id IN (${placeholders})`,
          )
          .all(GLOBAL_FEATURE, ...review.touched_node_ids) as Array<Omit<DashboardNode, "changed">>
      ).map((n) => ({ ...n, changed: true }));

      // Edges where BOTH endpoints are in the changed set.
      existingEdges = db
        .prepare(
          `SELECT from_node_id, to_node_id, edge_type, file, line FROM edges
           WHERE feature_name = ?
             AND from_node_id IN (${placeholders})
             AND to_node_id IN (${placeholders})`,
        )
        .all(GLOBAL_FEATURE, ...review.touched_node_ids, ...review.touched_node_ids) as DashboardEdge[];
    } finally {
      db.close();
    }
  }

  const newNodes = buildNewNodes(review);
  const allNodes = dedupeNodes([...existingNodes, ...newNodes]);
  const newEdges = buildNewEdges(review, allNodes);
  const allEdges = dedupeEdges([...existingEdges, ...newEdges]);

  return {
    status: "ok",
    cwd,
    changedFiles: annotateChangedFiles(review, allNodes, ignorePatterns),
    changedNodeIds: allNodes.map((n) => n.node_id),
    nodes: allNodes,
    edges: allEdges,
    raw: review.raw,
    coverageAction: review.coverage_action,
    stats: {
      changedCount: allNodes.length,
      edgeCount: allEdges.length,
    },
  };
}

/**
 * Impact: changed set + 1-hop ring (callers and callees).
 * Renders edges that touch the changed set (changed→neighbor and neighbor→changed),
 * but skips edges that exist purely between two neighbors.
 */
export async function buildImpactGraph(cwd: string): Promise<ImpactResponse> {
  const dbPath = path.join(cwd, DEFAULT_DB_PATH);
  const [review, ignorePatterns] = await Promise.all([runReview(cwd), loadIgnorePatterns(cwd)]);
  const { initGraphDb, openDatabase, runMigrations } = await getDbModule();

  const changedNodeIds = review.touched_node_ids;
  let nodesById = new Map<string, DashboardNode>();
  let edges: DashboardEdge[] = [];

  if (changedNodeIds.length > 0) {
    await initGraphDb(dbPath);
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      const placeholders = changedNodeIds.map(() => "?").join(",");

      // Changed nodes themselves.
      const changedNodes = (
        db
          .prepare(
            `SELECT node_id, symbol, kind, file, line FROM nodes
             WHERE feature_name = ? AND node_id IN (${placeholders})`,
          )
          .all(GLOBAL_FEATURE, ...changedNodeIds) as Array<Omit<DashboardNode, "changed">>
      ).map((n) => ({ ...n, changed: true }));
      for (const n of changedNodes) nodesById.set(n.node_id, n);

      // Edges where at least one endpoint is in the changed set.
      const ringEdges = db
        .prepare(
          `SELECT from_node_id, to_node_id, edge_type, file, line FROM edges
           WHERE feature_name = ?
             AND (from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders}))`,
        )
        .all(GLOBAL_FEATURE, ...changedNodeIds, ...changedNodeIds) as DashboardEdge[];
      edges = ringEdges;

      // Collect neighbor node IDs (anything in the edges that isn't already changed).
      const neighborIds = new Set<string>();
      for (const e of ringEdges) {
        if (!nodesById.has(e.from_node_id)) neighborIds.add(e.from_node_id);
        if (!nodesById.has(e.to_node_id)) neighborIds.add(e.to_node_id);
      }

      if (neighborIds.size > 0) {
        const neighborArr = [...neighborIds];
        const ph2 = neighborArr.map(() => "?").join(",");
        const neighborNodes = (
          db
            .prepare(
              `SELECT node_id, symbol, kind, file, line FROM nodes
               WHERE feature_name = ? AND node_id IN (${ph2})`,
            )
            .all(GLOBAL_FEATURE, ...neighborArr) as Array<Omit<DashboardNode, "changed">>
        ).map((n) => ({ ...n, changed: false }));
        for (const n of neighborNodes) nodesById.set(n.node_id, n);
      }
    } finally {
      db.close();
    }
  }

  // Add new symbols from the review (not yet in the db) as changed nodes.
  for (const n of buildNewNodes(review)) {
    nodesById.set(n.node_id, n);
  }
  // Stitch new edges from review on top.
  const allNodes = [...nodesById.values()];
  const newEdges = buildNewEdges(review, allNodes);
  const allEdges = dedupeEdges([...edges, ...newEdges]);

  const changedCount = allNodes.filter((n) => n.changed).length;
  const neighborCount = allNodes.length - changedCount;

  return {
    status: "ok",
    cwd,
    changedFiles: annotateChangedFiles(review, allNodes, ignorePatterns),
    changedNodeIds: allNodes.filter((n) => n.changed).map((n) => n.node_id),
    nodes: allNodes,
    edges: allEdges,
    coverageAction: review.coverage_action,
    stats: {
      changedCount,
      neighborCount,
      edgeCount: allEdges.length,
    },
  };
}

function dedupeNodes(nodes: DashboardNode[]): DashboardNode[] {
  const seen = new Map<string, DashboardNode>();
  for (const n of nodes) {
    const existing = seen.get(n.node_id);
    if (!existing || (!existing.changed && n.changed)) {
      seen.set(n.node_id, n);
    }
  }
  return [...seen.values()];
}

function dedupeEdges(edges: DashboardEdge[]): DashboardEdge[] {
  const seen = new Map<string, DashboardEdge>();
  for (const e of edges) {
    const key = `${e.from_node_id}→${e.to_node_id}:${e.edge_type}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}
