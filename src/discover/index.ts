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

interface DiscoverConfig {
  workspaces?: Record<string, { adapters?: string[]; exclude?: string[] }>;
  exclude?: string[];
  customBoundaries?: Array<{
    name: string;
    kind: string;
    glob: string;
    symbolPattern?: string;
    reason: string;
  }>;
  stack?: { enabled?: string[]; disabled?: string[] };
}

/**
 * Run full project discovery — detect workspaces, detect stack per workspace,
 * run framework adapters, collect all boundary nodes/edges/gaps.
 */
export async function discover(repoRoot: string, config?: DiscoverConfig): Promise<DiscoveryResult> {
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
    // Use config workspace overrides if available, otherwise use detected stack
    const wsConfig = config?.workspaces?.[ws.relativePath];
    const disabledAdapters = new Set(config?.stack?.disabled ?? []);

    let adapterNames: Set<string>;
    if (wsConfig?.adapters) {
      // Config explicitly sets adapters for this workspace
      adapterNames = new Set(wsConfig.adapters.filter((a) => !disabledAdapters.has(a)));
    } else {
      // Use auto-detected stack
      adapterNames = new Set(
        ws.stack.map((s) => s.adapter).filter((a) => !disabledAdapters.has(a))
      );
    }

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

  // Step 4: Scan custom boundaries from config
  if (config?.customBoundaries) {
    for (const cb of config.customBoundaries) {
      const { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId } = await import("./adapters/utils.js");
      const matchedFiles = await findFiles(absRoot, [cb.glob]);
      const symbolRegex = cb.symbolPattern ? new RegExp(cb.symbolPattern, "g") : null;

      for (const file of matchedFiles) {
        const content = await readFileSafe(file);
        if (!content) continue;
        const rel = toRelative(file, absRoot);

        if (symbolRegex) {
          // Extract symbols matching pattern
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(symbolRegex);
            if (match) {
              // Extract function/const name after the match
              const nameMatch = lines[i].match(/(?:function|const|let|class)\s+(\w+)/);
              if (nameMatch) {
                const symbol = nameMatch[1];
                const nodeId = makeNodeId(cb.kind, rel, symbol);
                if (!allNodes.some((n) => n.id === nodeId)) {
                  allNodes.push({
                    id: nodeId,
                    kind: cb.kind,
                    symbol,
                    file: rel,
                    line: i + 1,
                    reason: `${cb.reason}: ${symbol}`,
                    adapter: "custom",
                    metadata: { customBoundary: cb.name },
                  });
                  filesWithBoundaries.add(rel);
                }
              }
            }
          }
        } else {
          // No symbol pattern — register the file itself as a boundary
          const basename = path.basename(file, path.extname(file));
          const nodeId = makeNodeId(cb.kind, rel, basename);
          if (!allNodes.some((n) => n.id === nodeId)) {
            allNodes.push({
              id: nodeId,
              kind: cb.kind,
              symbol: basename,
              file: rel,
              line: 1,
              reason: cb.reason,
              adapter: "custom",
              metadata: { customBoundary: cb.name },
            });
            filesWithBoundaries.add(rel);
          }
        }
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
