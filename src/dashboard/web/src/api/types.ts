// Mirror of the server-side types. Kept hand-synced — the SPA is a separate
// TS project from the CLI source, so we duplicate the small response surface.

export interface StatusResponse {
  graphExists: boolean;
  dbPath: string;
  lastBuiltAt: string | null;
  cwd: string;
}

export interface BuildResult {
  status: "ok" | "error";
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface GraphNode {
  node_id: string;
  symbol: string;
  kind: string;
  file: string;
  line: number;
  changed: boolean;
  /** Number of memories anchored to this node. Omitted/0 = no indicator. */
  memory_count?: number;
  /** Subset of memory_count whose anchor is stale (symbol gone). > 0 turns the indicator amber. */
  stale_memory_count?: number;
}

export interface GraphEdge {
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  file: string | null;
  line: number | null;
}

export interface ChangedFile {
  file: string;
  tracked: boolean;
  /** Whether kk expects this file to have boundary nodes (TS/JS source, non-test, non-config). */
  relevant: boolean;
  /** True if matched by config.ignoreCoverage — silenced from the missing-coverage CTA. */
  ignored: boolean;
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

export interface PrecommitResponse {
  status: "ok";
  cwd: string;
  changedFiles: ChangedFile[];
  changedNodeIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  raw: unknown;
  coverageAction: CoverageAction | null;
  stats: {
    changedCount: number;
    edgeCount: number;
  };
}

export interface ImpactResponse {
  status: "ok";
  cwd: string;
  changedFiles: ChangedFile[];
  changedNodeIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverageAction: CoverageAction | null;
  stats: {
    changedCount: number;
    neighborCount: number;
    edgeCount: number;
  };
}

export interface NodeDetails {
  node_id: string;
  symbol: string;
  kind: string;
  file: string;
  line: number;
  changed: boolean;
  diff: string | null;
  source: string | null;
}

export type ViewKind = "precommit" | "impact";
