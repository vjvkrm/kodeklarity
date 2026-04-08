import fs from "node:fs/promises";
import path from "node:path";
import { detectWorkspaces } from "./workspace.js";
import { detectStack, getAdapter } from "./detector.js";
import type {
  DiscoveryResult,
  BoundaryNode,
  BoundaryEdge,
  DiscoveryGap,
  Workspace,
} from "./types.js";

export type { DiscoveryResult, BoundaryNode, BoundaryEdge, DiscoveryGap, Workspace };

/**
 * Run full project discovery — detect workspaces, detect stack per workspace,
 * run framework adapters, collect all boundary nodes/edges/gaps.
 */
export async function discover(repoRoot: string): Promise<DiscoveryResult> {
  const absRoot = path.resolve(repoRoot);

  // Step 1: Detect workspace structure
  const { tool, workspaces } = await detectWorkspaces(absRoot);

  if (workspaces.length === 0) {
    return emptyResult(absRoot);
  }

  // Step 2: Detect stack per workspace (with root package.json fallback for monorepo)
  let rootPackageJson: Record<string, unknown> | undefined;
  try {
    const raw = await fs.readFile(path.join(absRoot, "package.json"), "utf8");
    rootPackageJson = JSON.parse(raw);
  } catch {
    // no root package.json
  }

  for (const ws of workspaces) {
    const isRoot = ws.relativePath === ".";
    ws.stack = detectStack(ws, isRoot ? undefined : rootPackageJson);
  }

  // Step 3: Run adapters for each workspace
  const allNodes: BoundaryNode[] = [];
  const allEdges: BoundaryEdge[] = [];
  const allGaps: DiscoveryGap[] = [];
  const filesScanned = new Set<string>();
  const filesWithBoundaries = new Set<string>();

  for (const ws of workspaces) {
    // Collect unique adapter names from detected stack
    const adapterNames = new Set(ws.stack.map((s) => s.adapter));

    for (const adapterName of adapterNames) {
      const adapter = getAdapter(adapterName);
      if (!adapter) continue;

      const result = await adapter.scan(ws, absRoot);

      for (const node of result.nodes) {
        // Deduplicate by node id
        if (!allNodes.some((n) => n.id === node.id)) {
          allNodes.push(node);
          filesWithBoundaries.add(node.file);
        }
      }

      for (const edge of result.edges) {
        allEdges.push(edge);
      }

      // Collect gaps if adapter returned them
      const gaps = (result as unknown as Record<string, unknown>).gaps;
      if (Array.isArray(gaps)) {
        allGaps.push(...(gaps as DiscoveryGap[]));
      }
    }
  }

  // Count files scanned (approximate from all source files referenced)
  for (const node of allNodes) {
    filesScanned.add(node.file);
  }
  for (const edge of allEdges) {
    filesScanned.add(edge.file);
  }

  // Build stats
  const nodesByKind: Record<string, number> = {};
  for (const node of allNodes) {
    nodesByKind[node.kind] = (nodesByKind[node.kind] || 0) + 1;
  }

  const edgesByType: Record<string, number> = {};
  for (const edge of allEdges) {
    edgesByType[edge.edgeType] = (edgesByType[edge.edgeType] || 0) + 1;
  }

  return {
    repoRoot: absRoot,
    workspaces,
    nodes: allNodes,
    edges: allEdges,
    gaps: allGaps,
    stats: {
      filesScanned: filesScanned.size,
      filesWithBoundaries: filesWithBoundaries.size,
      filesNeedingReview: allGaps.length,
      nodesByKind,
      edgesByType,
    },
  };
}

function emptyResult(repoRoot: string): DiscoveryResult {
  return {
    repoRoot,
    workspaces: [],
    nodes: [],
    edges: [],
    gaps: [],
    stats: {
      filesScanned: 0,
      filesWithBoundaries: 0,
      filesNeedingReview: 0,
      nodesByKind: {},
      edgesByType: {},
    },
  };
}
