import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { Position } from "@xyflow/react";
import type { GraphEdge, GraphNode, ViewKind } from "../../api/types";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 56;

export interface KkNodeData extends Record<string, unknown> {
  symbol: string;
  kind: string;
  file: string;
  line: number;
  changed: boolean;
  memory_count?: number;
  stale_memory_count?: number;
}

export interface LayoutResult {
  nodes: Node<KkNodeData>[];
  edges: Edge[];
}

export function computeLayout(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  view: ViewKind,
): LayoutResult {
  if (graphNodes.length === 0) return { nodes: [], edges: [] };

  const changedSet = new Set(
    graphNodes.filter((n) => n.changed).map((n) => n.node_id),
  );

  // Defense-in-depth: in impact view, drop neighbor↔neighbor edges so the
  // change set stays the visual focus.
  const filteredEdges =
    view === "impact"
      ? graphEdges.filter(
          (e) => changedSet.has(e.from_node_id) || changedSet.has(e.to_node_id),
        )
      : graphEdges;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });

  for (const n of graphNodes) {
    g.setNode(n.node_id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const nodeIds = new Set(graphNodes.map((n) => n.node_id));
  const edgesForLayout = filteredEdges.filter(
    (e) => nodeIds.has(e.from_node_id) && nodeIds.has(e.to_node_id),
  );
  for (const e of edgesForLayout) {
    g.setEdge(e.from_node_id, e.to_node_id);
  }

  dagre.layout(g);

  const nodes: Node<KkNodeData>[] = graphNodes.map((n) => {
    const pos = g.node(n.node_id);
    return {
      id: n.node_id,
      type: "kk",
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        symbol: n.symbol,
        kind: n.kind,
        file: n.file,
        line: n.line,
        changed: n.changed,
        memory_count: n.memory_count,
        stale_memory_count: n.stale_memory_count,
      },
    };
  });

  const edges: Edge[] = edgesForLayout.map((e, i) => {
    const styleClass = edgeStyleFor(e.edge_type);
    return {
      id: `${e.from_node_id}->${e.to_node_id}-${i}`,
      source: e.from_node_id,
      target: e.to_node_id,
      type: "default",
      animated: false,
      data: { edgeType: e.edge_type, styleClass },
      style:
        styleClass === "dashed"
          ? { strokeDasharray: "6 4" }
          : styleClass === "dotted"
            ? { strokeDasharray: "1 4" }
            : undefined,
    };
  });

  return { nodes, edges };
}

function edgeStyleFor(t: string): "solid" | "dashed" | "dotted" {
  if (t === "writes" || t === "reads") return "dashed";
  if (t === "triggers" || t === "enqueues") return "dotted";
  return "solid";
}
