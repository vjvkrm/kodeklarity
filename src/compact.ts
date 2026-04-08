/**
 * Compact output transformer for agent-efficient token usage.
 *
 * Full JSON: 713 chars/entry, 19 fields → ~29k tokens for 150 results
 * Compact:   ~120 chars/entry, 5 fields  → ~5k tokens for 150 results
 * Summary:   grouped counts              → ~500 tokens regardless of result size
 */

interface CompactEntry {
  s: string;    // symbol
  k: string;    // kind
  e: string;    // edge type
  f: string;    // file
  d: number;    // depth
  c?: string;   // confidence (only if not "high")
}

interface CompactResult {
  status: string;
  symbol: string;
  total: number;
  summary: Record<string, Record<string, number>>; // { edge_type: { kind: count } }
  results: CompactEntry[];
}

/** Transform a full impact/upstream/downstream result to compact format */
export function compactifyTraversal(fullResult: any): CompactResult {
  const items = fullResult.impacts || fullResult.upstreams || fullResult.side_effects || [];
  const symbol = fullResult.symbol || "?";

  // Build summary: edge_type → { kind → count }
  const summary: Record<string, Record<string, number>> = {};
  for (const item of items) {
    const edgeType = item.edge_type || "unknown";
    const kind = item.from_kind || item.to_kind || "unknown";
    if (!summary[edgeType]) summary[edgeType] = {};
    summary[edgeType][kind] = (summary[edgeType][kind] || 0) + 1;
  }

  // Build compact entries
  const results: CompactEntry[] = items.map((item: any) => {
    const entry: CompactEntry = {
      s: item.from_symbol || item.to_symbol || item.side_effect_symbol || "?",
      k: item.from_kind || item.to_kind || "?",
      e: item.edge_type || "?",
      f: item.file || "",
      d: item.depth || 0,
    };
    if (item.confidence_label && item.confidence_label !== "high") {
      entry.c = item.confidence_label;
    }
    return entry;
  });

  // Deduplicate by symbol+kind+edgeType
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const key = `${r.s}:${r.k}:${r.e}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    status: fullResult.status || "ok",
    symbol,
    total: items.length,
    summary,
    results: deduped,
  };
}

/** Transform a risk result to compact format */
export function compactifyRisk(fullResult: any): any {
  // Risk is already compact enough
  return {
    status: fullResult.status,
    changed: fullResult.changed_file_count || fullResult.changed_files?.length || 0,
    affected: fullResult.affected_nodes || 0,
    impacts: fullResult.downstream_impacts || 0,
    side_effects: fullResult.side_effect_count || 0,
    risk: fullResult.risk_score || 0,
    label: fullResult.risk_label || "none",
    kinds: fullResult.impacted_kinds || {},
  };
}

/** Transform a status result to compact format */
export function compactifyStatus(fullResult: any): any {
  return {
    status: fullResult.status,
    nodes: fullResult.nodes,
    edges: fullResult.edges,
    kinds: fullResult.nodes_by_kind,
    edge_types: fullResult.edges_by_type,
    sha: fullResult.git_sha,
    branch: fullResult.git_branch,
  };
}

/** Generate a text summary optimized for LLM context (minimal tokens) */
export function summarizeTraversal(fullResult: any): string {
  const items = fullResult.impacts || fullResult.upstreams || fullResult.side_effects || [];
  const symbol = fullResult.symbol || "?";

  if (items.length === 0) return `No connections found for ${symbol}.`;

  // Group by edge_type → list of unique symbols
  const groups: Record<string, Set<string>> = {};
  for (const item of items) {
    const edgeType = item.edge_type || "unknown";
    const sym = item.from_symbol || item.to_symbol || item.side_effect_symbol || "?";
    if (!groups[edgeType]) groups[edgeType] = new Set();
    groups[edgeType].add(sym);
  }

  const lines = [`${symbol}: ${items.length} connections`];
  for (const [type, syms] of Object.entries(groups)) {
    const list = [...syms];
    if (list.length <= 5) {
      lines.push(`  ${type}: ${list.join(", ")}`);
    } else {
      lines.push(`  ${type}: ${list.slice(0, 5).join(", ")} +${list.length - 5} more`);
    }
  }

  return lines.join("\n");
}
