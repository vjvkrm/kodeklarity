/** Detected framework/library in a workspace */
export interface DetectedStack {
  name: string;
  version: string | null;
  adapter: string; // adapter key: "nextjs", "drizzle", etc.
}

/** A workspace within a monorepo, or the root for single-repo */
export interface Workspace {
  name: string;
  path: string; // absolute path
  relativePath: string; // relative to repo root
  packageJson: Record<string, unknown>;
  stack: DetectedStack[];
}

/** A discovered boundary node before graph insertion */
export interface BoundaryNode {
  id: string;
  kind: string;
  symbol: string;
  file: string; // relative to repo root
  line: number;
  reason: string;
  adapter: string; // which adapter found it
  metadata?: Record<string, unknown>;
}

/** A discovered boundary edge before graph insertion */
export interface BoundaryEdge {
  from: string; // node id
  to: string; // node id
  edgeType: string;
  file: string;
  line: number;
  reason: string;
  adapter: string;
  metadata?: Record<string, unknown>;
}

/** Result of framework adapter scan */
export interface AdapterResult {
  adapter: string;
  nodes: BoundaryNode[];
  edges: BoundaryEdge[];
}

/** Gap that static analysis couldn't resolve — flagged for agent */
export interface DiscoveryGap {
  file: string;
  lines?: string; // e.g. "45-60"
  reason: string;
  hint: string;
}

/** Full result of kk init discovery */
export interface DiscoveryResult {
  repoRoot: string;
  workspaces: Workspace[];
  nodes: BoundaryNode[];
  edges: BoundaryEdge[];
  gaps: DiscoveryGap[];
  stats: {
    filesScanned: number;
    filesWithBoundaries: number;
    filesNeedingReview: number;
    nodesByKind: Record<string, number>;
    edgesByType: Record<string, number>;
  };
}

/** Interface that every framework adapter must implement */
export interface FrameworkAdapter {
  name: string;
  detect(packageJson: Record<string, unknown>): DetectedStack | null;
  scan(workspace: Workspace, repoRoot: string): Promise<AdapterResult>;
}
