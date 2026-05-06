import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { GraphEdge, GraphNode, ViewKind } from "../../api/types";
import { useTheme } from "../../state/theme";
import { useView } from "../../state/view";
import { computeLayout, type KkNodeData } from "./layout";

interface GraphProps {
  view: ViewKind;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export default function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphInner({ view, nodes: graphNodes, edges: graphEdges }: GraphProps) {
  const selectedNodeId = useView((s) => s.selectedNodeId);
  const setSelectedNode = useView((s) => s.setSelectedNode);
  const search = useView((s) => s.search);
  const theme = useTheme((s) => s.theme);

  const layout = useMemo(
    () => computeLayout(graphNodes, graphEdges, view),
    [graphNodes, graphEdges, view],
  );

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<KkNodeData>>(layout.nodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>(layout.edges);

  useEffect(() => {
    setRfNodes(layout.nodes);
    setRfEdges(layout.edges);
  }, [layout, setRfNodes, setRfEdges]);

  // Adjacency lists keyed off the layout edges so we can BFS in both directions.
  const adjacency = useMemo(() => {
    const fwd = new Map<string, Set<string>>();
    const bwd = new Map<string, Set<string>>();
    for (const e of rfEdges) {
      if (!fwd.has(e.source)) fwd.set(e.source, new Set());
      fwd.get(e.source)!.add(e.target);
      if (!bwd.has(e.target)) bwd.set(e.target, new Set());
      bwd.get(e.target)!.add(e.source);
    }
    return { fwd, bwd };
  }, [rfEdges]);

  // When a node is selected: compute the transitive closure of upstream + downstream
  // reachable nodes. `direct` is the 1-hop ring for slightly stronger emphasis.
  const connection = useMemo(() => {
    if (!selectedNodeId) return null;
    const all = new Set<string>([selectedNodeId]);
    const direct = new Set<string>();
    const walk = (start: string, edges: Map<string, Set<string>>) => {
      const stack = [start];
      while (stack.length > 0) {
        const id = stack.pop()!;
        for (const nb of edges.get(id) ?? []) {
          if (id === selectedNodeId) direct.add(nb);
          if (!all.has(nb)) {
            all.add(nb);
            stack.push(nb);
          }
        }
      }
    };
    walk(selectedNodeId, adjacency.fwd);
    walk(selectedNodeId, adjacency.bwd);
    return { all, direct };
  }, [selectedNodeId, adjacency]);

  const decoratedNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rfNodes.map((n) => {
      const matchSearch = q.length === 0 || n.data.symbol.toLowerCase().includes(q);
      const inConnection = !connection || connection.all.has(n.id);
      const isSelected = n.id === selectedNodeId;
      const isDirect = connection?.direct.has(n.id) ?? false;

      const dim = !matchSearch || !inConnection;
      const opacity = dim ? 0.18 : 1;

      return {
        ...n,
        selected: isSelected,
        data: { ...n.data, _isDirect: isDirect, _isDimmed: dim },
        style: { ...(n.style ?? {}), opacity, transition: "opacity 150ms ease" },
      };
    });
  }, [rfNodes, selectedNodeId, search, connection]);

  const decoratedEdges = useMemo(() => {
    const dimStroke = theme === "dark" ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.14)";
    const accentStroke = theme === "dark" ? "#1f8bff" : "#0078d4";
    return rfEdges.map((e) => {
      const onPath =
        connection !== null &&
        connection.all.has(e.source) &&
        connection.all.has(e.target);
      const dim = connection !== null && !onPath;
      const stroke = onPath ? accentStroke : dimStroke;
      const width = onPath ? 1.8 : 1.25;

      return {
        ...e,
        markerEnd: { type: "arrowclosed" as const, color: stroke, width: 14, height: 14 },
        style: {
          ...(e.style ?? {}),
          stroke,
          strokeWidth: width,
          opacity: dim ? 0.18 : 1,
          transition: "opacity 150ms ease, stroke 150ms ease",
        },
      };
    });
  }, [rfEdges, theme, connection]);

  if (graphNodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center surface-canvas">
        <div className="max-w-md">
          <div
            className="w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-4"
            style={{ background: "var(--bg-subtle)", color: "var(--text-subtle)" }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M8 12h8" />
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold mb-1 text-default">No nodes to display</h2>
          <p className="text-[13px] text-muted leading-relaxed">
            {view === "precommit"
              ? "Nothing changed in your working tree."
              : "No impact graph available — try making a change and refreshing."}
          </p>
        </div>
      </div>
    );
  }

  const dotColor = theme === "dark" ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
  const accentChanged = theme === "dark" ? "#818cf8" : "#6366f1";
  const neighborColor = theme === "dark" ? "#3f3f46" : "#d4d4d8";

  return (
    <div className="flex-1 relative surface-canvas">
      <ReactFlow
        nodes={decoratedNodes}
        edges={decoratedEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => setSelectedNode(node.id)}
        onPaneClick={() => setSelectedNode(null)}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.1}
        maxZoom={2}
      >
        <Background gap={20} size={1.2} color={dotColor} />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => ((n.data as KkNodeData)?.changed ? accentChanged : neighborColor)}
          maskColor={theme === "dark" ? "rgba(8,8,10,0.7)" : "rgba(246,246,247,0.7)"}
          style={{
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border)",
          }}
        />
      </ReactFlow>
    </div>
  );
}

const NODE_TYPES = { kk: KkNode };

function KkNode({ data, selected }: NodeProps<Node<KkNodeData>>) {
  const { symbol, kind, changed } = data;
  const isDirect = (data as KkNodeData & { _isDirect?: boolean })._isDirect === true;
  const shape = shapeFor(kind);

  const fillStyle: React.CSSProperties = changed
    ? {
        background: "var(--accent)",
        color: "var(--accent-text)",
        borderColor: "color-mix(in srgb, var(--accent) 60%, black)",
      }
    : {
        background: "var(--bg-elevated)",
        color: "var(--text)",
        borderColor: isDirect ? "var(--accent)" : "var(--border-strong)",
      };

  const selectedStyle: React.CSSProperties = selected
    ? {
        boxShadow:
          "0 0 0 2px var(--accent-ring), 0 8px 28px -8px color-mix(in srgb, var(--accent) 50%, transparent)",
      }
    : isDirect
      ? {
          boxShadow:
            "0 0 0 1px var(--accent-ring), 0 4px 12px -6px color-mix(in srgb, var(--accent) 35%, transparent)",
        }
      : {
          boxShadow: changed
            ? "0 4px 14px -6px color-mix(in srgb, var(--accent) 40%, transparent)"
            : "0 1px 0 var(--border-strong)",
        };

  const baseInner = "flex items-center justify-center px-3 text-xs font-mono border transition-shadow";

  return (
    <div className="relative" style={{ width: 200, height: 56 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: "var(--text-subtle)", width: 6, height: 6, border: 0 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: "var(--text-subtle)", width: 6, height: 6, border: 0 }}
      />

      {shape === "rect" && (
        <div
          className={`${baseInner} w-full h-full rounded-md`}
          style={{ ...fillStyle, ...selectedStyle }}
          title={`${kind}: ${symbol}`}
        >
          <Label symbol={symbol} kind={kind} />
        </div>
      )}

      {shape === "pill" && (
        <div
          className={`${baseInner} w-full h-full rounded-full`}
          style={{ ...fillStyle, ...selectedStyle }}
          title={`${kind}: ${symbol}`}
        >
          <Label symbol={symbol} kind={kind} />
        </div>
      )}

      {shape === "hex" && (
        <div
          className={`${baseInner} w-full h-full`}
          style={{
            ...fillStyle,
            ...selectedStyle,
            clipPath: "polygon(12% 0, 88% 0, 100% 50%, 88% 100%, 12% 100%, 0 50%)",
          }}
          title={`${kind}: ${symbol}`}
        >
          <Label symbol={symbol} kind={kind} />
        </div>
      )}

      {shape === "cylinder" && (
        <div
          className={`${baseInner} w-full h-full rounded-[50%/22%]`}
          style={{ ...fillStyle, ...selectedStyle }}
          title={`${kind}: ${symbol}`}
        >
          <Label symbol={symbol} kind={kind} />
        </div>
      )}

      {shape === "diamond" && (
        <div className="w-full h-full flex items-center justify-center">
          <div
            className={`${baseInner}`}
            style={{
              ...fillStyle,
              ...selectedStyle,
              width: "70%",
              height: "100%",
              transform: "rotate(45deg)",
            }}
            title={`${kind}: ${symbol}`}
          >
            <div style={{ transform: "rotate(-45deg)", width: "140%", textAlign: "center" }}>
              <Label symbol={symbol} kind={kind} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Label({ symbol, kind }: { symbol: string; kind: string }) {
  return (
    <div className="flex flex-col items-center leading-tight overflow-hidden">
      <span className="text-[9px] uppercase tracking-wider opacity-70">{kind}</span>
      <span className="truncate max-w-[170px]">{symbol}</span>
    </div>
  );
}

type Shape = "rect" | "pill" | "hex" | "cylinder" | "diamond";

function shapeFor(kind: string): Shape {
  switch (kind) {
    case "route":
    case "api_route":
      return "rect";
    case "action":
    case "function":
      return "pill";
    case "job":
      return "hex";
    case "table":
    case "model":
      return "cylinder";
    case "type":
    case "interface":
      return "diamond";
    default:
      return "rect";
  }
}
