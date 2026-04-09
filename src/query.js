import path from "node:path";
import { spawnSync } from "node:child_process";
import { isObject, sanitizePathForCompare, parseJsonObjectSafe, clamp, readJsonFile, createGraphError } from "./utils.js";
import { withConfidence, buildGraphConfidenceGate } from "./confidence.js";
import {
  DEFAULT_KEEP_BUILDS,
  openDatabase,
  runMigrations,
  applyGraphPatch,
  initGraphDb,
} from "./db.js";
// Legacy build.js imports removed — functions that used them
// (rebuildGraphFromDiff, profileGraphWorkflow) are no longer available.
// Use kk init / kk rebuild instead.

export const RISK_FACTOR_WEIGHTS = Object.freeze({
  file_overlap_ratio: 0.3,
  impacted_node_ratio: 0.25,
  side_effect_reach_ratio: 0.3,
  start_node_coverage: 0.15,
});

export const PROFILE_TARGETS_MS = Object.freeze({
  verify: 500,
  build: 1200,
  risk: 800,
  total: 2500,
});

export function dedupeTraversalRows(rows) {
  const deduped = new Map();

  for (const row of rows) {
    const key = `${row.from_node_id}|${row.to_node_id}|${row.edge_type}|${row.file || ""}|${row.line || ""}`;
    const previous = deduped.get(key);

    if (!previous || row.depth < previous.depth) {
      deduped.set(key, row);
    }
  }

  return Array.from(deduped.values()).sort(
    (left, right) =>
      left.depth - right.depth ||
      left.from_node_id.localeCompare(right.from_node_id) ||
      left.to_node_id.localeCompare(right.to_node_id)
  );
}

export function resolveNodeReference(db, featureName, reference) {
  const byNodeId = db
    .prepare(
      `
SELECT node_id, kind, symbol, file, line, state, source
FROM nodes
WHERE feature_name = @feature_name AND node_id = @reference
LIMIT 1;
`
    )
    .get({
      feature_name: featureName,
      reference,
    });

  if (byNodeId) {
    return {
      ok: true,
      node: byNodeId,
    };
  }

  const bySymbol = db
    .prepare(
      `
SELECT node_id, kind, symbol, file, line, state, source
FROM nodes
WHERE feature_name = @feature_name AND symbol = @reference
ORDER BY node_id;
`
    )
    .all({
      feature_name: featureName,
      reference,
    });

  if (bySymbol.length === 1) {
    return {
      ok: true,
      node: bySymbol[0],
    };
  }

  if (bySymbol.length > 1) {
    return {
      ok: false,
      error: {
        code: "ambiguous_reference",
        message: `Reference '${reference}' matches multiple nodes in feature '${featureName}'.`,
        matches: bySymbol.map((node) => node.node_id),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "not_found",
      message: `Reference '${reference}' not found in feature '${featureName}'.`,
      matches: [],
    },
  };
}

export function findPathWhy(db, featureName, fromNodeId, toNodeId, maxDepth) {
  const edges = db
    .prepare(
      `
SELECT edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source
FROM edges
WHERE feature_name = @feature_name;
`
    )
    .all({ feature_name: featureName });

  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from_node_id)) {
      adjacency.set(edge.from_node_id, []);
    }

    adjacency.get(edge.from_node_id).push(edge);
  }

  const queue = [{ node_id: fromNodeId, depth: 0 }];
  const visited = new Set([fromNodeId]);
  const parent = new Map();

  let found = false;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];

    if (current.node_id === toNodeId) {
      found = true;
      break;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const outgoing = adjacency.get(current.node_id) || [];
    for (const edge of outgoing) {
      if (visited.has(edge.to_node_id)) {
        continue;
      }

      visited.add(edge.to_node_id);
      parent.set(edge.to_node_id, {
        previous_node_id: current.node_id,
        edge,
      });
      queue.push({
        node_id: edge.to_node_id,
        depth: current.depth + 1,
      });
    }
  }

  if (!found && fromNodeId !== toNodeId) {
    return {
      found: false,
      steps: [],
      depth: 0,
    };
  }

  if (fromNodeId === toNodeId) {
    return {
      found: true,
      steps: [],
      depth: 0,
    };
  }

  const steps = [];
  let cursor = toNodeId;

  while (cursor !== fromNodeId) {
    const link = parent.get(cursor);
    if (!link) {
      return {
        found: false,
        steps: [],
        depth: 0,
      };
    }

    steps.push(link.edge);
    cursor = link.previous_node_id;
  }

  steps.reverse();

  return {
    found: true,
    steps,
    depth: steps.length,
  };
}

export async function queryImpact(options) {
  const dbPath = options.dbPath;
  const feature = options.feature;
  const symbol = options.symbol;
  const depth = options.depth;

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const startNodes = db
      .prepare(
        `
SELECT node_id, kind, symbol, file, line, state, source
FROM nodes
WHERE feature_name = @feature AND symbol = @symbol
ORDER BY node_id;
`
      )
      .all({ feature, symbol });

    const startNodesWithConfidence = startNodes.map((node) =>
      withConfidence(node, [
        {
          state: node.state,
          source: node.source,
        },
      ])
    );

    if (startNodes.length === 0) {
      return {
        status: "ok",
        db_path: dbPath,
        feature,
        symbol,
        depth,
        start_nodes: startNodesWithConfidence,
        impacts: [],
        impact_count: 0,
      };
    }

    const impacts = db
      .prepare(
        `
WITH RECURSIVE
start_nodes AS (
  SELECT node_id
  FROM nodes
  WHERE feature_name = @feature
    AND symbol = @symbol
),
walk AS (
  SELECT
    1 AS depth,
    e.from_node_id,
    e.to_node_id,
    e.edge_type,
    e.state AS edge_state,
    e.source AS edge_source,
    e.file,
    e.line,
    e.reason,
    e.from_node_id || '->' || e.to_node_id AS path
  FROM edges e
  JOIN start_nodes s ON s.node_id = e.from_node_id
  WHERE e.feature_name = @feature

  UNION ALL

  SELECT
    w.depth + 1,
    e.from_node_id,
    e.to_node_id,
    e.edge_type,
    e.state AS edge_state,
    e.source AS edge_source,
    e.file,
    e.line,
    e.reason,
    w.path || '->' || e.to_node_id
  FROM walk w
  JOIN edges e ON e.feature_name = @feature AND e.from_node_id = w.to_node_id
  WHERE w.depth < @max_depth
    AND instr(w.path, '->' || e.to_node_id) = 0
)
SELECT
  w.depth,
  w.from_node_id,
  nf.symbol AS from_symbol,
  nf.state AS from_state,
  nf.source AS from_source,
  w.to_node_id,
  nt.symbol AS to_symbol,
  nt.kind AS to_kind,
  nt.state AS to_state,
  nt.source AS to_source,
  w.edge_type,
  w.edge_state,
  w.edge_source,
  w.file,
  w.line,
  w.reason
FROM walk w
LEFT JOIN nodes nf ON nf.feature_name = @feature AND nf.node_id = w.from_node_id
LEFT JOIN nodes nt ON nt.feature_name = @feature AND nt.node_id = w.to_node_id
ORDER BY w.depth, w.from_node_id, w.to_node_id;
`
      )
      .all({ feature, symbol, max_depth: depth });

    const impactsWithConfidence = dedupeTraversalRows(impacts).map((impact) =>
      withConfidence(impact, [
        { state: impact.edge_state, source: impact.edge_source },
        { state: impact.from_state, source: impact.from_source },
        { state: impact.to_state, source: impact.to_source },
      ])
    );

    return {
      status: "ok",
      db_path: dbPath,
      feature,
      symbol,
      depth,
      start_nodes: startNodesWithConfidence,
      impacts: impactsWithConfidence,
      impact_count: impactsWithConfidence.length,
    };
  } finally {
    db.close();
  }
}

export async function queryDownstream(options) {
  const impactResult = await queryImpact(options);

  if (impactResult.status !== "ok") {
    return impactResult;
  }

  return {
    ...impactResult,
    downstreams: impactResult.impacts,
    downstream_count: impactResult.impact_count,
  };
}

export async function queryUpstream(options) {
  const dbPath = options.dbPath;
  const feature = options.feature;
  const symbol = options.symbol;
  const depth = options.depth;

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const startNodes = db
      .prepare(
        `
SELECT node_id, kind, symbol, file, line, state, source
FROM nodes
WHERE feature_name = @feature AND symbol = @symbol
ORDER BY node_id;
`
      )
      .all({ feature, symbol });

    const startNodesWithConfidence = startNodes.map((node) =>
      withConfidence(node, [
        {
          state: node.state,
          source: node.source,
        },
      ])
    );

    if (startNodes.length === 0) {
      return {
        status: "ok",
        db_path: dbPath,
        feature,
        symbol,
        depth,
        start_nodes: startNodesWithConfidence,
        upstreams: [],
        upstream_count: 0,
      };
    }

    const upstreamRows = db
      .prepare(
        `
WITH RECURSIVE
start_nodes AS (
  SELECT node_id
  FROM nodes
  WHERE feature_name = @feature
    AND symbol = @symbol
),
walk AS (
  SELECT
    1 AS depth,
    e.from_node_id,
    e.to_node_id,
    e.edge_type,
    e.state AS edge_state,
    e.source AS edge_source,
    e.file,
    e.line,
    e.reason,
    e.to_node_id || '<-' || e.from_node_id AS path
  FROM edges e
  JOIN start_nodes s ON s.node_id = e.to_node_id
  WHERE e.feature_name = @feature

  UNION ALL

  SELECT
    w.depth + 1,
    e.from_node_id,
    e.to_node_id,
    e.edge_type,
    e.state AS edge_state,
    e.source AS edge_source,
    e.file,
    e.line,
    e.reason,
    w.path || '<-' || e.from_node_id
  FROM walk w
  JOIN edges e ON e.feature_name = @feature AND e.to_node_id = w.from_node_id
  WHERE w.depth < @max_depth
    AND instr(w.path, '<-' || e.from_node_id) = 0
)
SELECT
  w.depth,
  w.from_node_id,
  nf.symbol AS from_symbol,
  nf.kind AS from_kind,
  nf.state AS from_state,
  nf.source AS from_source,
  w.to_node_id,
  nt.symbol AS to_symbol,
  nt.kind AS to_kind,
  nt.state AS to_state,
  nt.source AS to_source,
  w.edge_type,
  w.edge_state,
  w.edge_source,
  w.file,
  w.line,
  w.reason
FROM walk w
LEFT JOIN nodes nf ON nf.feature_name = @feature AND nf.node_id = w.from_node_id
LEFT JOIN nodes nt ON nt.feature_name = @feature AND nt.node_id = w.to_node_id
ORDER BY w.depth, w.from_node_id, w.to_node_id;
`
      )
      .all({ feature, symbol, max_depth: depth });

    const upstreams = dedupeTraversalRows(upstreamRows).map((row) =>
      withConfidence(row, [
        { state: row.edge_state, source: row.edge_source },
        { state: row.from_state, source: row.from_source },
        { state: row.to_state, source: row.to_source },
      ])
    );

    return {
      status: "ok",
      db_path: dbPath,
      feature,
      symbol,
      depth,
      start_nodes: startNodesWithConfidence,
      upstreams,
      upstream_count: upstreams.length,
    };
  } finally {
    db.close();
  }
}

export async function querySideEffects(options) {
  const dbPath = options.dbPath;
  const feature = options.feature;
  const symbol = options.symbol;
  const depth = options.depth;

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const startNodes = db
      .prepare(
        `
SELECT node_id, kind, symbol, file, line, state, source
FROM nodes
WHERE feature_name = @feature AND symbol = @symbol
ORDER BY node_id;
`
      )
      .all({ feature, symbol });

    const startNodesWithConfidence = startNodes.map((node) =>
      withConfidence(node, [
        {
          state: node.state,
          source: node.source,
        },
      ])
    );

    if (startNodes.length === 0) {
      return {
        status: "ok",
        db_path: dbPath,
        feature,
        symbol,
        depth,
        start_nodes: startNodesWithConfidence,
        side_effects: [],
        side_effect_count: 0,
      };
    }

    const rows = db
      .prepare(
        `
WITH RECURSIVE
start_nodes AS (
  SELECT node_id
  FROM nodes
  WHERE feature_name = @feature
    AND symbol = @symbol
),
walk AS (
  SELECT
    1 AS depth,
    e.from_node_id,
    e.to_node_id,
    e.edge_type,
    e.state AS edge_state,
    e.source AS edge_source,
    e.file,
    e.line,
    e.reason,
    e.from_node_id || '->' || e.to_node_id AS path
  FROM edges e
  JOIN start_nodes s ON s.node_id = e.from_node_id
  WHERE e.feature_name = @feature

  UNION ALL

  SELECT
    w.depth + 1,
    e.from_node_id,
    e.to_node_id,
    e.edge_type,
    e.state AS edge_state,
    e.source AS edge_source,
    e.file,
    e.line,
    e.reason,
    w.path || '->' || e.to_node_id
  FROM walk w
  JOIN edges e ON e.feature_name = @feature AND e.from_node_id = w.to_node_id
  WHERE w.depth < @max_depth
    AND instr(w.path, '->' || e.to_node_id) = 0
)
SELECT
  w.depth,
  w.from_node_id,
  nf.symbol AS from_symbol,
  nf.state AS from_state,
  nf.source AS from_source,
  w.to_node_id,
  nt.symbol AS side_effect_symbol,
  nt.kind AS to_kind,
  nt.state AS side_effect_state,
  nt.source AS side_effect_source,
  nt.file AS side_effect_file,
  nt.line AS side_effect_line,
  nt.reason AS side_effect_reason,
  nt.metadata_json AS side_effect_metadata_json,
  w.edge_type,
  w.edge_state,
  w.edge_source,
  w.file,
  w.line,
  w.reason
FROM walk w
LEFT JOIN nodes nf ON nf.feature_name = @feature AND nf.node_id = w.from_node_id
LEFT JOIN nodes nt ON nt.feature_name = @feature AND nt.node_id = w.to_node_id
WHERE nt.kind IN ('side_effect', 'table', 'external_api', 'event', 'background_job', 'rls_policy')
ORDER BY w.depth, w.from_node_id, w.to_node_id;
`
      )
      .all({ feature, symbol, max_depth: depth });

    const sideEffects = rows.map((row) => {
      const metadata = parseJsonObjectSafe(row.side_effect_metadata_json);
      return withConfidence(
        {
        depth: row.depth,
        from_node_id: row.from_node_id,
        from_symbol: row.from_symbol,
        to_node_id: row.to_node_id,
        side_effect_symbol: row.side_effect_symbol,
        side_effect_kind:
          typeof metadata.side_effect_kind === "string" && metadata.side_effect_kind.trim()
            ? metadata.side_effect_kind
            : null,
        side_effect_target:
          typeof metadata.target === "string" && metadata.target.trim() ? metadata.target : null,
        edge_type: row.edge_type,
        file: row.file,
        line: row.line,
        reason: row.reason,
        side_effect_file: row.side_effect_file,
        side_effect_line: row.side_effect_line,
        side_effect_reason: row.side_effect_reason,
        },
        [
          { state: row.edge_state, source: row.edge_source },
          { state: row.from_state, source: row.from_source },
          { state: row.side_effect_state, source: row.side_effect_source },
        ]
      );
    });

    return {
      status: "ok",
      db_path: dbPath,
      feature,
      symbol,
      depth,
      start_nodes: startNodesWithConfidence,
      side_effects: sideEffects,
      side_effect_count: sideEffects.length,
    };
  } finally {
    db.close();
  }
}

export function computeWeightedRiskProfile(inputs) {
  const trackedFileCount = inputs.trackedFileCount;
  const changedFileCount = inputs.changedFileCount;
  const overlapCount = inputs.overlapCount;
  const totalNodeCount = inputs.totalNodeCount;
  const sideEffectNodeCount = inputs.sideEffectNodeCount;
  const startNodeCount = inputs.startNodeCount;
  const impactedNodeCount = inputs.impactedNodeCount;
  const reachableSideEffectCount = inputs.reachableSideEffectCount;

  const values = {
    file_overlap_ratio:
      changedFileCount > 0 ? clamp(overlapCount / Math.max(changedFileCount, 1), 0, 1) : 0,
    impacted_node_ratio: totalNodeCount > 0 ? clamp(impactedNodeCount / totalNodeCount, 0, 1) : 0,
    side_effect_reach_ratio:
      sideEffectNodeCount > 0 ? clamp(reachableSideEffectCount / sideEffectNodeCount, 0, 1) : 0,
    start_node_coverage: overlapCount > 0 ? (startNodeCount > 0 ? 1 : 0) : 0,
  };

  const riskFactors = {};
  let weightedTotal = 0;
  for (const [key, weight] of Object.entries(RISK_FACTOR_WEIGHTS)) {
    const value = values[key] ?? 0;
    const contribution = value * weight;
    weightedTotal += contribution;
    riskFactors[key] = {
      value: Number(value.toFixed(4)),
      weight,
      contribution: Number(contribution.toFixed(4)),
    };
  }

  const riskScore = Math.round(clamp(weightedTotal, 0, 1) * 100);
  let riskLevel = "low";
  if (riskScore >= 75) {
    riskLevel = "high";
  } else if (riskScore >= 45) {
    riskLevel = "medium";
  }

  let riskReason = "weighted_factors";
  if (reachableSideEffectCount > 0 && riskLevel !== "low") {
    riskReason = "weighted_factors_with_reachable_side_effects";
  } else if (overlapCount > 0 && startNodeCount === 0) {
    riskReason = "weighted_factors_with_mapping_gap";
  } else if (trackedFileCount === 0) {
    riskReason = "no_feature_graph";
  } else if (overlapCount === 0) {
    riskReason = "no_feature_overlap";
  }

  return {
    risk_level: riskLevel,
    risk_score: riskScore,
    risk_reason: riskReason,
    risk_factors: riskFactors,
  };
}

export function normalizePathForDiffComparison(filePath, baseDir) {
  if (typeof filePath !== "string") {
    return null;
  }

  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
  return sanitizePathForCompare(path.normalize(absolutePath));
}

export function getChangedFileCompareCandidates(filePath, cwd, repositoryRoot) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return [];
  }

  const trimmed = filePath.trim();
  if (path.isAbsolute(trimmed)) {
    return [sanitizePathForCompare(path.normalize(trimmed))];
  }

  const candidates = [
    normalizePathForDiffComparison(trimmed, cwd),
    normalizePathForDiffComparison(trimmed, repositoryRoot),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

export function parseChangedFilesInput(inputValue) {
  if (Array.isArray(inputValue)) {
    return inputValue
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .map((value) => sanitizePathForCompare(value));
  }

  if (typeof inputValue !== "string" || !inputValue.trim()) {
    return [];
  }

  return inputValue
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => sanitizePathForCompare(value));
}

export function getChangedFilesFromGit(cwd, baseRef, headRef) {
  const result = spawnSync("git", ["diff", "--name-only", `${baseRef}..${headRef}`], {
    cwd,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`git diff execution failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const rawDetails = (result.stderr || result.stdout || "git diff failed").trim();
    const firstLine = rawDetails.split(/\r?\n/, 1)[0] || "git diff failed";
    throw new Error(firstLine);
  }

  return parseChangedFilesInput(result.stdout);
}

export function parseGitDiffHunks(diffText) {
  const rangesByFile = {};
  let currentFile = null;

  const lines = typeof diffText === "string" ? diffText.split(/\r?\n/) : [];
  for (const rawLine of lines) {
    const line = rawLine || "";

    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!match) {
        currentFile = null;
        continue;
      }

      const fromPath = sanitizePathForCompare(match[1].trim().replace(/^"(.*)"$/, "$1"));
      const toPath = sanitizePathForCompare(match[2].trim().replace(/^"(.*)"$/, "$1"));
      currentFile = toPath === "/dev/null" ? fromPath : toPath;
      if (!rangesByFile[currentFile]) {
        rangesByFile[currentFile] = [];
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunkMatch) {
      continue;
    }

    const start = Number.parseInt(hunkMatch[3], 10);
    const countRaw = hunkMatch[4];
    const count = countRaw === undefined ? 1 : Number.parseInt(countRaw, 10);
    const safeCount = Number.isInteger(count) && count >= 0 ? count : 1;
    const safeStart = Number.isInteger(start) && start >= 1 ? start : 1;
    const end = safeCount === 0 ? safeStart : safeStart + safeCount - 1;

    rangesByFile[currentFile].push({
      start: safeStart,
      end,
      count: safeCount,
    });
  }

  return rangesByFile;
}

export function getChangedFileRangesFromGit(cwd, baseRef, headRef) {
  const result = spawnSync("git", ["diff", "--no-color", "--unified=0", `${baseRef}..${headRef}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`git diff execution failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const rawDetails = (result.stderr || result.stdout || "git diff failed").trim();
    const firstLine = rawDetails.split(/\r?\n/, 1)[0] || "git diff failed";
    throw new Error(firstLine);
  }

  return parseGitDiffHunks(result.stdout);
}

export function buildFileLevelRanges(changedFiles) {
  const ranges = {};
  const list = Array.isArray(changedFiles) ? changedFiles : [];

  for (const filePath of list) {
    const normalized = sanitizePathForCompare(filePath);
    if (!normalized) {
      continue;
    }

    ranges[normalized] = [];
  }

  return ranges;
}

export function isLineInRanges(line, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return true;
  }

  if (!Number.isInteger(line) || line < 1) {
    return true;
  }

  for (const range of ranges) {
    if (!isObject(range)) {
      continue;
    }

    const start = Number.isInteger(range.start) ? range.start : 1;
    const end = Number.isInteger(range.end) ? range.end : start;
    const count = Number.isInteger(range.count) ? range.count : Math.max(0, end - start + 1);

    if (count === 0) {
      return true;
    }

    if (line >= start && line <= end) {
      return true;
    }
  }

  return false;
}

export function buildScopeMatcher(changedFiles, fileRangesByFile, cwd, repositoryRoot) {
  const compareRanges = new Map();
  const list = Array.isArray(changedFiles) ? changedFiles : [];

  for (const changedFile of list) {
    const changedKey = sanitizePathForCompare(changedFile);
    const ranges = fileRangesByFile?.[changedKey] || [];
    const candidates = getChangedFileCompareCandidates(changedFile, cwd, repositoryRoot);
    for (const candidate of candidates) {
      compareRanges.set(candidate, ranges);
    }
  }

  return {
    compare_paths: Array.from(compareRanges.keys()),
    matches(filePath, line) {
      if (typeof filePath !== "string" || !filePath.trim()) {
        return false;
      }

      const candidates = getChangedFileCompareCandidates(filePath, cwd, repositoryRoot);
      for (const candidate of candidates) {
        if (!compareRanges.has(candidate)) {
          continue;
        }

        const ranges = compareRanges.get(candidate);
        if (isLineInRanges(line, ranges)) {
          return true;
        }
      }

      return false;
    },
  };
}

export function getFeatureTrackedFiles(db, featureName, repositoryRoot) {
  const rows = db
    .prepare(
      `
SELECT file
FROM nodes
WHERE feature_name = @feature_name AND file IS NOT NULL
UNION
SELECT file
FROM edges
WHERE feature_name = @feature_name AND file IS NOT NULL;
`
    )
    .all({ feature_name: featureName });

  const display = Array.from(
    new Set(
      rows
        .map((row) => (typeof row.file === "string" ? sanitizePathForCompare(row.file.trim()) : null))
        .filter(Boolean)
    )
  );

  const compare = Array.from(
    new Set(
      rows
        .map((row) => normalizePathForDiffComparison(row.file, repositoryRoot))
        .filter(Boolean)
    )
  );

  return {
    display,
    compare,
  };
}

export async function queryRisk(options) {
  const cwd = options.cwd;
  const dbPath = options.dbPath;
  const requestPath = path.resolve(cwd, options.requestPath);
  const baseRef = typeof options.baseRef === "string" && options.baseRef.trim() ? options.baseRef.trim() : "HEAD~1";
  const headRef = typeof options.headRef === "string" && options.headRef.trim() ? options.headRef.trim() : "HEAD";
  const depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : 6;

  const payload = await readJsonFile(requestPath);
  const normalizedRequest = normalizeInputRequestShape(payload, cwd);
  const featureName = normalizedRequest.feature?.name;
  const repositoryRootRaw = normalizedRequest.repository?.root;
  const repositoryRoot =
    typeof repositoryRootRaw === "string" && repositoryRootRaw.trim()
      ? path.resolve(cwd, repositoryRootRaw)
      : cwd;

  if (typeof featureName !== "string" || !featureName.trim()) {
    throw new Error("request payload must include feature.name for risk query");
  }

  const changedFiles =
    options.changedFiles && options.changedFiles.length > 0
      ? parseChangedFilesInput(options.changedFiles)
      : getChangedFilesFromGit(cwd, baseRef, headRef);

  if (changedFiles.length === 0) {
    return {
      status: "ok",
      db_path: dbPath,
      request_path: requestPath,
      feature: featureName,
      base_ref: baseRef,
      head_ref: headRef,
      max_depth: depth,
      changed_files: [],
      tracked_feature_files: [],
      matched_feature_files: [],
      overlap_count: 0,
      start_nodes: [],
      impacted_nodes: [],
      impacted_node_count: 0,
      reachable_side_effects: [],
      side_effect_count: 0,
      rebuild_recommended: false,
      risk_level: "none",
      risk_score: 0,
      risk_reason: "no_changed_files",
      risk_factors: {
        file_overlap_ratio: { value: 0, weight: RISK_FACTOR_WEIGHTS.file_overlap_ratio, contribution: 0 },
        impacted_node_ratio: { value: 0, weight: RISK_FACTOR_WEIGHTS.impacted_node_ratio, contribution: 0 },
        side_effect_reach_ratio: { value: 0, weight: RISK_FACTOR_WEIGHTS.side_effect_reach_ratio, contribution: 0 },
        start_node_coverage: { value: 0, weight: RISK_FACTOR_WEIGHTS.start_node_coverage, contribution: 0 },
      },
    };
  }

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const tracked = getFeatureTrackedFiles(db, featureName, repositoryRoot);
    const trackedFeatureFiles = tracked.display;
    const trackedCompareSet = new Set(tracked.compare);

    const matchedFeatureFiles = [];
    const matchedComparePaths = new Set();

    for (const changedFile of changedFiles) {
      const candidates = getChangedFileCompareCandidates(changedFile, cwd, repositoryRoot);
      const overlaps = candidates.filter((candidate) => trackedCompareSet.has(candidate));
      if (overlaps.length > 0) {
        matchedFeatureFiles.push(changedFile);
        for (const candidate of overlaps) {
          matchedComparePaths.add(candidate);
        }
      }
    }

    const nodeRows = db
      .prepare(
        `
SELECT node_id, kind, symbol, file, line, reason, metadata_json, state, source
FROM nodes
WHERE feature_name = @feature_name;
`
      )
      .all({ feature_name: featureName });

    const edgeRows = db
      .prepare(
        `
SELECT from_node_id, to_node_id, edge_type, file, line, reason, state, source
FROM edges
WHERE feature_name = @feature_name;
`
      )
      .all({ feature_name: featureName });

    if (trackedFeatureFiles.length === 0) {
      return {
        status: "ok",
        db_path: dbPath,
        request_path: requestPath,
        feature: featureName,
        base_ref: baseRef,
        head_ref: headRef,
        max_depth: depth,
        changed_files: changedFiles,
        tracked_feature_files: [],
        matched_feature_files: [],
        overlap_count: 0,
        start_nodes: [],
        impacted_nodes: [],
        impacted_node_count: 0,
        reachable_side_effects: [],
        side_effect_count: 0,
        rebuild_recommended: false,
        risk_level: "unknown",
        risk_score: null,
        risk_reason: "no_feature_graph",
        risk_factors: {},
      };
    }

    if (matchedFeatureFiles.length === 0) {
      return {
        status: "ok",
        db_path: dbPath,
        request_path: requestPath,
        feature: featureName,
        base_ref: baseRef,
        head_ref: headRef,
        max_depth: depth,
        changed_files: changedFiles,
        tracked_feature_files: trackedFeatureFiles,
        matched_feature_files: [],
        overlap_count: 0,
        start_nodes: [],
        impacted_nodes: [],
        impacted_node_count: 0,
        reachable_side_effects: [],
        side_effect_count: 0,
        rebuild_recommended: false,
        risk_level: "low",
        risk_score: 10,
        risk_reason: "no_feature_overlap",
        risk_factors: {
          file_overlap_ratio: { value: 0, weight: RISK_FACTOR_WEIGHTS.file_overlap_ratio, contribution: 0 },
          impacted_node_ratio: { value: 0, weight: RISK_FACTOR_WEIGHTS.impacted_node_ratio, contribution: 0 },
          side_effect_reach_ratio: { value: 0, weight: RISK_FACTOR_WEIGHTS.side_effect_reach_ratio, contribution: 0 },
          start_node_coverage: { value: 0, weight: RISK_FACTOR_WEIGHTS.start_node_coverage, contribution: 0 },
        },
      };
    }

    const nodeById = new Map(nodeRows.map((row) => [row.node_id, row]));
    const adjacency = new Map();
    for (const edge of edgeRows) {
      const bucket = adjacency.get(edge.from_node_id) || [];
      bucket.push(edge);
      adjacency.set(edge.from_node_id, bucket);
    }

    const startNodes = [];
    const startNodeIdSet = new Set();
    for (const node of nodeRows) {
      const comparePath = normalizePathForDiffComparison(node.file, repositoryRoot);
      if (!comparePath || !matchedComparePaths.has(comparePath)) {
        continue;
      }

      startNodes.push({
        node_id: node.node_id,
        kind: node.kind,
        symbol: node.symbol,
        file: node.file,
        line: node.line,
        state: node.state,
        source: node.source,
      });
      startNodeIdSet.add(node.node_id);
    }

    const visitedDepth = new Map();
    const queue = [];
    for (const startNodeId of startNodeIdSet) {
      visitedDepth.set(startNodeId, 0);
      queue.push({ node_id: startNodeId, depth: 0 });
    }

    const impactedNodeMap = new Map();
    const sideEffectMap = new Map();

    while (queue.length > 0) {
      const current = queue.shift();
      const outgoingEdges = adjacency.get(current.node_id) || [];

      for (const edge of outgoingEdges) {
        const nextDepth = current.depth + 1;
        if (nextDepth > depth) {
          continue;
        }

        const nextNodeId = edge.to_node_id;
        const existingDepth = visitedDepth.get(nextNodeId);
        if (existingDepth === undefined || nextDepth < existingDepth) {
          visitedDepth.set(nextNodeId, nextDepth);
          queue.push({ node_id: nextNodeId, depth: nextDepth });
        }

        const nextNode = nodeById.get(nextNodeId);
        if (!nextNode) {
          continue;
        }

        const impactedEntry = {
          depth: nextDepth,
          node_id: nextNode.node_id,
          kind: nextNode.kind,
          symbol: nextNode.symbol,
          file: nextNode.file,
          line: nextNode.line,
          state: nextNode.state,
          source: nextNode.source,
        };

        const previousImpacted = impactedNodeMap.get(nextNodeId);
        if (!previousImpacted || impactedEntry.depth < previousImpacted.depth) {
          impactedNodeMap.set(nextNodeId, impactedEntry);
        }

        if (nextNode.kind === "side_effect") {
          const metadata = parseJsonObjectSafe(nextNode.metadata_json);
          const sideEffectEntry = {
            depth: nextDepth,
            via_node_id: edge.from_node_id,
            via_symbol: nodeById.get(edge.from_node_id)?.symbol || null,
            node_id: nextNode.node_id,
            symbol: nextNode.symbol,
            side_effect_kind:
              typeof metadata.side_effect_kind === "string" && metadata.side_effect_kind.trim()
                ? metadata.side_effect_kind
                : null,
            side_effect_target:
              typeof metadata.target === "string" && metadata.target.trim() ? metadata.target : null,
            edge_type: edge.edge_type,
            file: edge.file,
            line: edge.line,
            reason: edge.reason,
            side_effect_file: nextNode.file,
            side_effect_line: nextNode.line,
            side_effect_reason: nextNode.reason,
            edge_state: edge.state,
            edge_source: edge.source,
            side_effect_state: nextNode.state,
            side_effect_source: nextNode.source,
            via_state: nodeById.get(edge.from_node_id)?.state,
            via_source: nodeById.get(edge.from_node_id)?.source,
          };

          const previousSideEffect = sideEffectMap.get(nextNodeId);
          if (!previousSideEffect || sideEffectEntry.depth < previousSideEffect.depth) {
            sideEffectMap.set(nextNodeId, sideEffectEntry);
          }
        }
      }
    }

    const impactedNodes = Array.from(impactedNodeMap.values())
      .map((entry) =>
        withConfidence(entry, [
          { state: entry.state, source: entry.source },
        ])
      )
      .sort(
      (left, right) => left.depth - right.depth || left.node_id.localeCompare(right.node_id)
      );

    const reachableSideEffects = Array.from(sideEffectMap.values())
      .map((entry) =>
        withConfidence(entry, [
          { state: entry.edge_state, source: entry.edge_source },
          { state: entry.side_effect_state, source: entry.side_effect_source },
          { state: entry.via_state, source: entry.via_source },
        ])
      )
      .sort((left, right) => left.depth - right.depth || left.node_id.localeCompare(right.node_id));

    const startNodesWithConfidence = startNodes.map((entry) =>
      withConfidence(entry, [
        { state: entry.state, source: entry.source },
      ])
    );

    const sideEffectNodeCount = nodeRows.filter((row) => row.kind === "side_effect").length;
    const weightedRisk = computeWeightedRiskProfile({
      trackedFileCount: trackedFeatureFiles.length,
      changedFileCount: changedFiles.length,
      overlapCount: matchedFeatureFiles.length,
      totalNodeCount: nodeRows.length,
      sideEffectNodeCount,
      startNodeCount: startNodes.length,
      impactedNodeCount: impactedNodes.length,
      reachableSideEffectCount: reachableSideEffects.length,
    });

    if (startNodes.length === 0 && matchedFeatureFiles.length > 0) {
      weightedRisk.risk_level = "unknown";
      weightedRisk.risk_score = null;
      weightedRisk.risk_reason = "feature_overlap_but_no_mapped_start_nodes";
    }

    return {
      status: "ok",
      db_path: dbPath,
      request_path: requestPath,
      feature: featureName,
      base_ref: baseRef,
      head_ref: headRef,
      max_depth: depth,
      changed_files: changedFiles,
      tracked_feature_files: trackedFeatureFiles,
      matched_feature_files: matchedFeatureFiles,
      overlap_count: matchedFeatureFiles.length,
      start_nodes: startNodesWithConfidence,
      impacted_nodes: impactedNodes,
      impacted_node_count: impactedNodes.length,
      reachable_side_effects: reachableSideEffects,
      side_effect_count: reachableSideEffects.length,
      rebuild_recommended: matchedFeatureFiles.length > 0,
      risk_level: weightedRisk.risk_level,
      risk_score: weightedRisk.risk_score,
      risk_reason: weightedRisk.risk_reason,
      risk_factors: weightedRisk.risk_factors,
    };
  } finally {
    db.close();
  }
}

export async function queryWhy(options) {
  const dbPath = options.dbPath;
  const feature = options.feature;
  const fromRef = options.from;
  const toRef = options.to;
  const depth = options.depth;

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const fromResolved = resolveNodeReference(db, feature, fromRef);
    if (!fromResolved.ok) {
      return {
        status: "error",
        error_code: "FROM_REFERENCE_ERROR",
        message: fromResolved.error.message,
        matches: fromResolved.error.matches,
      };
    }

    const toResolved = resolveNodeReference(db, feature, toRef);
    if (!toResolved.ok) {
      return {
        status: "error",
        error_code: "TO_REFERENCE_ERROR",
        message: toResolved.error.message,
        matches: toResolved.error.matches,
      };
    }

    const fromNode = fromResolved.node;
    const toNode = toResolved.node;

    const pathResult = findPathWhy(db, feature, fromNode.node_id, toNode.node_id, depth);

    const involvedNodeIds = new Set([fromNode.node_id, toNode.node_id]);
    for (const edge of pathResult.steps) {
      involvedNodeIds.add(edge.from_node_id);
      involvedNodeIds.add(edge.to_node_id);
    }

    const nodeDetails = new Map();
    const readNode = db.prepare(
      `
SELECT node_id, kind, symbol, file, line, state, source
FROM nodes
WHERE feature_name = @feature_name AND node_id = @node_id
LIMIT 1;
`
    );

    for (const nodeId of involvedNodeIds) {
      const row = readNode.get({ feature_name: feature, node_id: nodeId });
      if (row) {
        nodeDetails.set(
          nodeId,
          withConfidence(row, [
            { state: row.state, source: row.source },
          ])
        );
      }
    }

    const resolvedFrom = withConfidence(fromNode, [
      { state: fromNode.state, source: fromNode.source },
    ]);
    const resolvedTo = withConfidence(toNode, [
      { state: toNode.state, source: toNode.source },
    ]);

    return {
      status: "ok",
      db_path: dbPath,
      feature,
      from: fromRef,
      to: toRef,
      resolved_from_node: resolvedFrom,
      resolved_to_node: resolvedTo,
      max_depth: depth,
      path_found: pathResult.found,
      path_depth: pathResult.depth,
      steps: pathResult.steps.map((edge, index) => {
        const fromInfo = nodeDetails.get(edge.from_node_id);
        const toInfo = nodeDetails.get(edge.to_node_id);

        return withConfidence(
          {
            step: index + 1,
            from_node_id: edge.from_node_id,
            from_symbol: fromInfo?.symbol || null,
            to_node_id: edge.to_node_id,
            to_symbol: toInfo?.symbol || null,
            edge_type: edge.edge_type,
            file: edge.file,
            line: edge.line,
            reason: edge.reason,
          },
          [
            { state: edge.state, source: edge.source },
            { state: fromInfo?.state, source: fromInfo?.source },
            { state: toInfo?.state, source: toInfo?.source },
          ]
        );
      }),
    };
  } finally {
    db.close();
  }
}

export function buildComparableNodeSnapshot(row) {
  return JSON.stringify({
    kind: row.kind || null,
    symbol: row.symbol || null,
    file: row.file || null,
    line: row.line || null,
    reason: row.reason || null,
    state: row.state || null,
    source: row.source || null,
    request_id: row.request_id || null,
    metadata_json: row.metadata_json || "{}",
  });
}

export function buildComparableEdgeSnapshot(row) {
  return JSON.stringify({
    from_node_id: row.from_node_id || null,
    to_node_id: row.to_node_id || null,
    edge_type: row.edge_type || null,
    file: row.file || null,
    line: row.line || null,
    reason: row.reason || null,
    state: row.state || null,
    source: row.source || null,
    request_id: row.request_id || null,
    metadata_json: row.metadata_json || "{}",
  });
}

export function buildDiffSets(leftRows, rightRows, idKey, snapshotBuilder) {
  const leftById = new Map(leftRows.map((row) => [row[idKey], row]));
  const rightById = new Map(rightRows.map((row) => [row[idKey], row]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, row] of rightById.entries()) {
    if (!leftById.has(id)) {
      added.push(row);
      continue;
    }

    const leftRow = leftById.get(id);
    if (snapshotBuilder(leftRow) !== snapshotBuilder(row)) {
      changed.push({
        id,
        before: leftRow,
        after: row,
      });
    }
  }

  for (const [id, row] of leftById.entries()) {
    if (!rightById.has(id)) {
      removed.push(row);
    }
  }

  return {
    added,
    removed,
    changed,
  };
}

export async function queryBuildDiff(options) {
  const dbPath = options.dbPath;
  const feature = options.feature;
  const buildA = options.buildA;
  const buildB = options.buildB;

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const readBuild = db.prepare(
      `
SELECT build_id, feature_name, request_id, request_path, intake_mode, trigger_kind, trigger_details_json, created_at, node_count, edge_count
FROM builds
WHERE feature_name = @feature_name AND build_id = @build_id
LIMIT 1;
`
    );

    const buildRowA = readBuild.get({ feature_name: feature, build_id: buildA });
    if (!buildRowA) {
      return {
        status: "error",
        error_code: "BUILD_A_NOT_FOUND",
        message: `Build '${buildA}' not found for feature '${feature}'.`,
      };
    }

    const buildRowB = readBuild.get({ feature_name: feature, build_id: buildB });
    if (!buildRowB) {
      return {
        status: "error",
        error_code: "BUILD_B_NOT_FOUND",
        message: `Build '${buildB}' not found for feature '${feature}'.`,
      };
    }

    const readBuildNodes = db.prepare(
      `
SELECT node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json
FROM build_nodes
WHERE feature_name = @feature_name AND build_id = @build_id
ORDER BY node_id;
`
    );

    const readBuildEdges = db.prepare(
      `
SELECT edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json
FROM build_edges
WHERE feature_name = @feature_name AND build_id = @build_id
ORDER BY edge_id;
`
    );

    const nodesA = readBuildNodes.all({ feature_name: feature, build_id: buildA });
    const nodesB = readBuildNodes.all({ feature_name: feature, build_id: buildB });
    const edgesA = readBuildEdges.all({ feature_name: feature, build_id: buildA });
    const edgesB = readBuildEdges.all({ feature_name: feature, build_id: buildB });

    const nodeDiff = buildDiffSets(nodesA, nodesB, "node_id", buildComparableNodeSnapshot);
    const edgeDiff = buildDiffSets(edgesA, edgesB, "edge_id", buildComparableEdgeSnapshot);

    return {
      status: "ok",
      db_path: dbPath,
      feature,
      build_a: {
        build_id: buildRowA.build_id,
        created_at: buildRowA.created_at,
      },
      build_b: {
        build_id: buildRowB.build_id,
        created_at: buildRowB.created_at,
      },
      node_diff: {
        added_count: nodeDiff.added.length,
        removed_count: nodeDiff.removed.length,
        changed_count: nodeDiff.changed.length,
        added: nodeDiff.added,
        removed: nodeDiff.removed,
        changed: nodeDiff.changed,
      },
      edge_diff: {
        added_count: edgeDiff.added.length,
        removed_count: edgeDiff.removed.length,
        changed_count: edgeDiff.changed.length,
        added: edgeDiff.added,
        removed: edgeDiff.removed,
        changed: edgeDiff.changed,
      },
    };
  } finally {
    db.close();
  }
}

export async function rebuildGraphFromDiff(options) {
  const cwd = options.cwd;
  const dbPath = options.dbPath;
  const requestPath = path.resolve(cwd, options.requestPath);
  const baseRef = typeof options.baseRef === "string" && options.baseRef.trim() ? options.baseRef.trim() : "HEAD~1";
  const headRef = typeof options.headRef === "string" && options.headRef.trim() ? options.headRef.trim() : "HEAD";
  const keepBuilds =
    Number.isInteger(options.keepBuilds) && options.keepBuilds > 0 ? options.keepBuilds : DEFAULT_KEEP_BUILDS;

  const payload = await readJsonFile(requestPath);
  const normalizedRequest = normalizeInputRequestShape(payload, cwd);
  const featureName = normalizedRequest.feature?.name;
  const repositoryRootRaw = normalizedRequest.repository?.root;
  const repositoryRoot =
    typeof repositoryRootRaw === "string" && repositoryRootRaw.trim()
      ? path.resolve(cwd, repositoryRootRaw)
      : cwd;

  if (typeof featureName !== "string" || !featureName.trim()) {
    throw new Error("request payload must include feature.name for rebuild strategy");
  }

  const changedFiles = options.changedFiles && options.changedFiles.length > 0
    ? parseChangedFilesInput(options.changedFiles)
    : getChangedFilesFromGit(cwd, baseRef, headRef);

  const diffRangesRaw =
    options.changedFiles && options.changedFiles.length > 0
      ? buildFileLevelRanges(changedFiles)
      : getChangedFileRangesFromGit(cwd, baseRef, headRef);

  const changedFileRanges = {};
  for (const [filePath, ranges] of Object.entries(diffRangesRaw || {})) {
    const normalized = sanitizePathForCompare(filePath);
    if (!normalized) {
      continue;
    }

    changedFileRanges[normalized] = Array.isArray(ranges) ? ranges : [];
  }

  for (const changedFile of changedFiles) {
    const normalized = sanitizePathForCompare(changedFile);
    if (!normalized) {
      continue;
    }

    if (!Array.isArray(changedFileRanges[normalized])) {
      changedFileRanges[normalized] = [];
    }
  }

  if (changedFiles.length === 0) {
    return {
      status: "skipped",
      reason: "no_changed_files",
      db_path: dbPath,
      request_path: requestPath,
      feature: featureName,
      base_ref: baseRef,
      head_ref: headRef,
      changed_files: [],
      matched_feature_files: [],
      changed_file_ranges: changedFileRanges,
    };
  }

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  let trackedFeatureFiles;
  let trackedFeatureFilesForCompare;
  try {
    runMigrations(db);
    const tracked = getFeatureTrackedFiles(db, featureName, repositoryRoot);
    trackedFeatureFiles = tracked.display;
    trackedFeatureFilesForCompare = tracked.compare;
  } finally {
    db.close();
  }

  const trackedSet = new Set(trackedFeatureFilesForCompare);
  const matchedFeatureFiles = changedFiles.filter((filePath) => {
    const candidates = getChangedFileCompareCandidates(filePath, cwd, repositoryRoot);
    return candidates.some((candidate) => trackedSet.has(candidate));
  });

  if (trackedFeatureFiles.length > 0 && matchedFeatureFiles.length === 0) {
    return {
      status: "skipped",
      reason: "no_feature_overlap",
      db_path: dbPath,
      request_path: requestPath,
      feature: featureName,
      base_ref: baseRef,
      head_ref: headRef,
      changed_files: changedFiles,
      tracked_feature_files: trackedFeatureFiles,
      matched_feature_files: [],
      changed_file_ranges: changedFileRanges,
    };
  }

  if (trackedFeatureFiles.length === 0) {
    const triggerDetails = {
      base_ref: baseRef,
      head_ref: headRef,
      changed_files: changedFiles,
      changed_file_ranges: changedFileRanges,
      matched_feature_files: matchedFeatureFiles,
      tracked_feature_files: trackedFeatureFiles,
      strategy: "no_existing_feature_graph",
    };

    const buildResult = await buildGraphFromRequestFile({
      cwd,
      dbPath,
      requestPath,
      keepBuilds,
      triggerKind: "git_diff",
      triggerDetails,
    });

    return {
      ...buildResult,
      strategy: triggerDetails.strategy,
      base_ref: baseRef,
      head_ref: headRef,
      changed_files: changedFiles,
      changed_file_ranges: changedFileRanges,
      matched_feature_files: matchedFeatureFiles,
      tracked_feature_files: trackedFeatureFiles,
    };
  }

  const verification = await verifyRequestEvidence(normalizedRequest, cwd);
  const verificationPayload = formatVerificationPayload(verification);
  if (!verification.ok) {
    throw createGraphError("AST_VERIFICATION_FAILED", "AST verification failed before incremental rebuild.", {
      ...verificationPayload,
      retry_hint: "Fix file/symbol/line evidence fields and rerun graph rebuild.",
    });
  }

  const graph = buildGraphFromRequest(normalizedRequest);
  const astExpansion = await expandGraphFromOriginsWithAst(graph, normalizedRequest, verificationPayload.repository_root);
  const confidenceGate = buildGraphConfidenceGate(graph, options.minConfidenceScore);
  const scopeMatcher = buildScopeMatcher(changedFiles, changedFileRanges, cwd, repositoryRoot);

  const triggerDetails = {
    base_ref: baseRef,
    head_ref: headRef,
    changed_files: changedFiles,
    changed_file_ranges: changedFileRanges,
    matched_feature_files: matchedFeatureFiles,
    tracked_feature_files: trackedFeatureFiles,
    strategy: "incremental_hunk_patch",
    scoped_compare_paths: scopeMatcher.compare_paths,
  };

  const patchDb = openDatabase(dbPath);
  try {
    runMigrations(patchDb);
    const patchMeta = applyGraphPatch(patchDb, {
      graph,
      requestPath,
      keepBuilds,
      triggerKind: "git_diff_incremental",
      triggerDetails,
      scopeMatcher,
    });

    return {
      status: "ok",
      build_id: patchMeta.build_id,
      pruned_builds: patchMeta.pruned_builds,
      patch_stats: patchMeta.patch_stats,
      db_path: dbPath,
      request_path: requestPath,
      feature: graph.featureName,
      intake_mode: graph.intakeMode,
      strategy: triggerDetails.strategy,
      base_ref: baseRef,
      head_ref: headRef,
      changed_files: changedFiles,
      changed_file_ranges: changedFileRanges,
      matched_feature_files: matchedFeatureFiles,
      tracked_feature_files: trackedFeatureFiles,
      verification: {
        checked_claims: verificationPayload.checked_claims,
        repository_root: verificationPayload.repository_root,
        issue_summary: verificationPayload.issue_summary,
        verification_confidence: verificationPayload.verification_confidence,
      },
      ast_expansion: astExpansion,
      confidence_gate: confidenceGate,
      counts: {
        nodes: patchMeta.patch_stats.resulting_nodes,
        edges: patchMeta.patch_stats.resulting_edges,
      },
    };
  } finally {
    patchDb.close();
  }
}

export function evaluateProfileStage(durationMs, targetMs) {
  return {
    duration_ms: Number(durationMs.toFixed(2)),
    target_ms: targetMs,
    within_target: durationMs <= targetMs,
  };
}
