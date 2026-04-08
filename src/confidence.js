import { isObject, clamp } from "./utils.js";

export const CONFIDENCE_STATE_WEIGHTS = Object.freeze({
  verified: 1.0,
  inferred: 0.58,
  unknown: 0.4,
});

export const CONFIDENCE_SOURCE_WEIGHTS = Object.freeze({
  request: 1.0,
  ast_inferred: 0.74,
  request_placeholder: 0.46,
  unknown: 0.45,
});

export const DEFAULT_CONFIDENCE_MIN_SCORE = 60;

export function getConfidenceLabel(score) {
  if (score >= 80) {
    return "high";
  }

  if (score >= 55) {
    return "medium";
  }

  return "low";
}

export function buildConfidencePayload(score01) {
  const normalized = clamp(score01, 0, 1);
  const score = Math.round(normalized * 100);

  return {
    confidence_score: score,
    confidence_label: getConfidenceLabel(score),
  };
}

export function scoreStateSourcePair(state, source) {
  const stateWeight =
    typeof state === "string" && state.trim()
      ? CONFIDENCE_STATE_WEIGHTS[state.trim().toLowerCase()] ?? CONFIDENCE_STATE_WEIGHTS.unknown
      : CONFIDENCE_STATE_WEIGHTS.unknown;

  const sourceWeight =
    typeof source === "string" && source.trim()
      ? CONFIDENCE_SOURCE_WEIGHTS[source.trim().toLowerCase()] ?? CONFIDENCE_SOURCE_WEIGHTS.unknown
      : CONFIDENCE_SOURCE_WEIGHTS.unknown;

  return clamp(stateWeight * 0.7 + sourceWeight * 0.3, 0, 1);
}

export function buildConfidenceFromPairs(pairs) {
  const values = Array.isArray(pairs) ? pairs : [];
  const scores = [];

  for (const pair of values) {
    if (!isObject(pair)) {
      continue;
    }

    scores.push(scoreStateSourcePair(pair.state, pair.source));
  }

  if (scores.length === 0) {
    return buildConfidencePayload(0.5);
  }

  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return buildConfidencePayload(average);
}

export function withConfidence(row, pairs) {
  return {
    ...row,
    ...buildConfidenceFromPairs(pairs),
  };
}

export function countStates(items) {
  const rows = Array.isArray(items) ? items : [];
  const counts = {
    verified: 0,
    inferred: 0,
    unknown: 0,
  };

  for (const item of rows) {
    const state = typeof item?.state === "string" ? item.state.trim().toLowerCase() : "unknown";
    if (state === "verified") {
      counts.verified += 1;
    } else if (state === "inferred") {
      counts.inferred += 1;
    } else {
      counts.unknown += 1;
    }
  }

  return counts;
}

export function averageConfidenceScore(items) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    return 0;
  }

  let total = 0;
  for (const row of rows) {
    total += buildConfidenceFromPairs([
      {
        state: row.state,
        source: row.source,
      },
    ]).confidence_score;
  }

  return Math.round(total / rows.length);
}

export function buildGraphConfidenceGate(graph, minConfidenceScore) {
  const minScore =
    Number.isInteger(minConfidenceScore) && minConfidenceScore >= 1 && minConfidenceScore <= 100
      ? minConfidenceScore
      : DEFAULT_CONFIDENCE_MIN_SCORE;

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const nodeStateCounts = countStates(nodes);
  const edgeStateCounts = countStates(edges);

  const nodeConfidence = averageConfidenceScore(nodes);
  const edgeConfidence = averageConfidenceScore(edges);
  const overallConfidence = Math.round(nodeConfidence * 0.4 + edgeConfidence * 0.6);

  const inferredEdgeRatio = edges.length > 0 ? edgeStateCounts.inferred / edges.length : 0;
  const inferredNodeRatio = nodes.length > 0 ? nodeStateCounts.inferred / nodes.length : 0;

  let gateStatus = "pass";
  if (
    overallConfidence < Math.max(20, minScore - 25) ||
    (edges.length > 0 && inferredEdgeRatio > 0.9 && edgeStateCounts.verified === 0)
  ) {
    gateStatus = "fail";
  } else if (overallConfidence < minScore || inferredEdgeRatio > 0.7 || inferredNodeRatio > 0.8) {
    gateStatus = "warn";
  }

  const reasons = [];
  if (overallConfidence < minScore) {
    reasons.push("overall_confidence_below_threshold");
  }
  if (inferredEdgeRatio > 0.7) {
    reasons.push("inferred_edge_ratio_high");
  }
  if (edgeStateCounts.verified === 0 && edges.length > 0) {
    reasons.push("no_verified_edges");
  }
  if (nodeStateCounts.verified === 0 && nodes.length > 0) {
    reasons.push("no_verified_nodes");
  }

  const guidance = [];
  if (inferredEdgeRatio > 0.7) {
    guidance.push("Provide explicit api_edges/service_edges evidence to anchor inferred AST links.");
  }
  if (edgeStateCounts.verified === 0 && edges.length > 0) {
    guidance.push("Add at least one verified relation in payload to improve trustable path quality.");
  }
  if (overallConfidence < minScore) {
    guidance.push("Add additional file/symbol/line evidence before relying on this graph for risky refactors.");
  }

  return {
    gate_status: gateStatus,
    min_confidence_score: minScore,
    confidence_score: overallConfidence,
    confidence_label: getConfidenceLabel(overallConfidence),
    inferred_edge_ratio: Number(inferredEdgeRatio.toFixed(4)),
    inferred_node_ratio: Number(inferredNodeRatio.toFixed(4)),
    state_counts: {
      nodes: nodeStateCounts,
      edges: edgeStateCounts,
    },
    reasons,
    guidance,
  };
}
