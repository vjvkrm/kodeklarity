import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isObject, readJsonFile, parseJsonObjectSafe, sanitizePathForCompare, toRepoRelativePath, createGraphError, clamp } from "./utils.js";
import { buildConfidencePayload, buildConfidenceFromPairs, buildGraphConfidenceGate } from "./confidence.js";
import {
  DEFAULT_KEEP_BUILDS,
  openDatabase,
  runMigrations,
  applyGraphBuild,
  applyGraphPatch,
  initGraphDb,
} from "./db.js";
import { collectSymbolsFromSource, loadFileAstInfo, pickBestDeclaration, collectCallSitesFromDeclaration } from "./ast.js";
import {
  loadTsConfigAliasResolver,
  loadAstExpansionFileInfo,
  resolveCallTarget,
} from "./resolve.js";
import { normalizeAndValidatePayload } from "./validate-request.js";

export const AST_EXPANSION_MAX_DEPTH = 3;
export const AST_EXPANSION_MAX_EDGES = 300;
export const SNAPSHOT_FORMAT_VERSION = "kk.snapshot.v1";

export function inferNodeKind(nodeId) {
  if (nodeId.startsWith("ui.")) {
    return "entrypoint";
  }
  if (nodeId.startsWith("api.")) {
    return "api";
  }
  if (nodeId.startsWith("service.")) {
    return "service";
  }
  if (nodeId.startsWith("dto.")) {
    return "dto";
  }
  if (nodeId.startsWith("origin.")) {
    return "origin";
  }
  if (nodeId.startsWith("side_effect.")) {
    return "side_effect";
  }

  return "unknown";
}

export function inferSymbol(nodeId) {
  const parts = nodeId.split(".");
  const candidate = parts[parts.length - 1];
  return candidate && candidate.trim() ? candidate.trim() : undefined;
}

export function mapSideEffectEdgeType(kind) {
  switch (kind) {
    case "db_read":
      return "reads";
    case "db_write":
      return "writes";
    case "event_publish":
      return "emits";
    case "external_http":
      return "external_call";
    default:
      return "side_effect";
  }
}

export function mergeNode(existing, incoming) {
  return {
    ...existing,
    kind: existing.kind === "unknown" && incoming.kind !== "unknown" ? incoming.kind : existing.kind,
    symbol: existing.symbol || incoming.symbol,
    file: existing.file || incoming.file,
    line: existing.line || incoming.line,
    reason: existing.reason || incoming.reason,
    metadata: {
      ...(existing.metadata || {}),
      ...(incoming.metadata || {}),
    },
  };
}

export function addOrMergeNode(nodeMap, node) {
  const existing = nodeMap.get(node.node_id);
  if (!existing) {
    nodeMap.set(node.node_id, node);
    return;
  }

  nodeMap.set(node.node_id, mergeNode(existing, node));
}

export function findNodeIdBySymbol(nodeMap, symbol) {
  if (!symbol) {
    return null;
  }

  for (const [nodeId, node] of nodeMap.entries()) {
    if (node.symbol === symbol) {
      return nodeId;
    }
  }

  return null;
}

export function ensurePlaceholderNode(nodeMap, nodeId, featureName, requestId, evidence) {
  addOrMergeNode(nodeMap, {
    node_id: nodeId,
    kind: inferNodeKind(nodeId),
    symbol: inferSymbol(nodeId),
    file: evidence?.file,
    line: evidence?.line,
    reason: evidence?.reason,
    state: "inferred",
    source: "request_placeholder",
    request_id: requestId,
    feature_name: featureName,
    metadata: {
      placeholder: true,
    },
  });
}

export function normalizeInputRequestShape(rawPayload, cwd) {
  if (isObject(rawPayload) && isObject(rawPayload.feature) && isObject(rawPayload.boundaries)) {
    const requestId = typeof rawPayload.request_id === "string" ? rawPayload.request_id : `adhoc-${Date.now()}`;
    const createdAt = typeof rawPayload.created_at === "string" ? rawPayload.created_at : new Date().toISOString();

    return {
      request_id: requestId,
      created_at: createdAt,
      schema_version: rawPayload.schema_version || "1.1",
      source: rawPayload.source || "llm_payload",
      intake_mode: rawPayload.intake_mode || "full",
      feature: rawPayload.feature,
      repository: rawPayload.repository,
      boundaries: rawPayload.boundaries,
      notes: rawPayload.notes,
    };
  }

  const validation = normalizeAndValidatePayload(rawPayload, cwd, "auto");
  if (!validation.ok) {
    const details = JSON.stringify(validation.error, null, 2);
    throw new Error(`graph build payload validation failed:\n${details}`);
  }

  return {
    request_id: `adhoc-${Date.now()}`,
    created_at: new Date().toISOString(),
    ...validation.value,
  };
}

export function buildGraphFromRequest(request) {
  const featureName = request.feature?.name;
  if (typeof featureName !== "string" || !featureName.trim()) {
    throw new Error("request.feature.name is required to build graph");
  }

  const requestId = request.request_id || `adhoc-${Date.now()}`;
  const boundaries = isObject(request.boundaries) ? request.boundaries : {};

  const origins = Array.isArray(boundaries.origins) ? boundaries.origins : [];
  const entrypoints = Array.isArray(boundaries.entrypoints) ? boundaries.entrypoints : [];
  const apiEdges = Array.isArray(boundaries.api_edges) ? boundaries.api_edges : [];
  const serviceEdges = Array.isArray(boundaries.service_edges) ? boundaries.service_edges : [];
  const sideEffects = Array.isArray(boundaries.side_effects) ? boundaries.side_effects : [];

  const nodeMap = new Map();
  const edges = [];

  for (const origin of origins) {
    if (!origin || typeof origin.id !== "string") {
      continue;
    }

    addOrMergeNode(nodeMap, {
      node_id: origin.id,
      kind: origin.kind || "origin",
      symbol: origin.symbol,
      file: origin.evidence?.file,
      line: origin.evidence?.line,
      reason: origin.evidence?.reason,
      state: "verified",
      source: "request",
      request_id: requestId,
      feature_name: featureName,
      metadata: {
        source_group: "origins",
      },
    });
  }

  for (const entrypoint of entrypoints) {
    if (!entrypoint || typeof entrypoint.id !== "string") {
      continue;
    }

    addOrMergeNode(nodeMap, {
      node_id: entrypoint.id,
      kind: entrypoint.kind || "entrypoint",
      symbol: entrypoint.symbol,
      file: entrypoint.evidence?.file,
      line: entrypoint.evidence?.line,
      reason: entrypoint.evidence?.reason,
      state: "verified",
      source: "request",
      request_id: requestId,
      feature_name: featureName,
      metadata: {
        source_group: "entrypoints",
      },
    });
  }

  for (const [index, edge] of apiEdges.entries()) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") {
      continue;
    }

    ensurePlaceholderNode(nodeMap, edge.from, featureName, requestId, edge.evidence);
    ensurePlaceholderNode(nodeMap, edge.to, featureName, requestId, edge.evidence);

    edges.push({
      edge_id: `api.${index + 1}:${edge.from}->${edge.to}`,
      from_node_id: edge.from,
      to_node_id: edge.to,
      edge_type: "calls_api",
      file: edge.evidence?.file,
      line: edge.evidence?.line,
      reason: edge.evidence?.reason,
      state: "verified",
      source: "request",
      request_id: requestId,
      feature_name: featureName,
      metadata: {
        source_group: "api_edges",
        symbol: edge.symbol,
      },
    });
  }

  for (const [index, edge] of serviceEdges.entries()) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") {
      continue;
    }

    ensurePlaceholderNode(nodeMap, edge.from, featureName, requestId, edge.evidence);
    ensurePlaceholderNode(nodeMap, edge.to, featureName, requestId, edge.evidence);

    edges.push({
      edge_id: `service.${index + 1}:${edge.from}->${edge.to}`,
      from_node_id: edge.from,
      to_node_id: edge.to,
      edge_type: "invokes_service",
      file: edge.evidence?.file,
      line: edge.evidence?.line,
      reason: edge.evidence?.reason,
      state: "verified",
      source: "request",
      request_id: requestId,
      feature_name: featureName,
      metadata: {
        source_group: "service_edges",
        symbol: edge.symbol,
      },
    });
  }

  const fallbackSourceNode =
    (origins[0] && typeof origins[0].id === "string" && origins[0].id) ||
    (entrypoints[0] && typeof entrypoints[0].id === "string" && entrypoints[0].id) ||
    null;

  for (const [index, sideEffect] of sideEffects.entries()) {
    if (!sideEffect || typeof sideEffect.kind !== "string" || typeof sideEffect.target !== "string") {
      continue;
    }

    const sideNodeId = `side_effect.${sideEffect.kind}.${sideEffect.target}.${index + 1}`;

    addOrMergeNode(nodeMap, {
      node_id: sideNodeId,
      kind: "side_effect",
      symbol: sideEffect.symbol,
      file: sideEffect.evidence?.file,
      line: sideEffect.evidence?.line,
      reason: sideEffect.evidence?.reason,
      state: "verified",
      source: "request",
      request_id: requestId,
      feature_name: featureName,
      metadata: {
        source_group: "side_effects",
        side_effect_kind: sideEffect.kind,
        target: sideEffect.target,
      },
    });

    const sourceNodeFromSymbol = findNodeIdBySymbol(nodeMap, sideEffect.symbol);
    const sourceNodeId = sourceNodeFromSymbol || fallbackSourceNode || "unknown.feature.source";

    ensurePlaceholderNode(nodeMap, sourceNodeId, featureName, requestId, sideEffect.evidence);

    edges.push({
      edge_id: `side.${index + 1}:${sourceNodeId}->${sideNodeId}`,
      from_node_id: sourceNodeId,
      to_node_id: sideNodeId,
      edge_type: mapSideEffectEdgeType(sideEffect.kind),
      file: sideEffect.evidence?.file,
      line: sideEffect.evidence?.line,
      reason: sideEffect.evidence?.reason,
      state: "verified",
      source: "request",
      request_id: requestId,
      feature_name: featureName,
      metadata: {
        source_group: "side_effects",
      },
    });
  }

  return {
    featureName,
    requestId,
    intakeMode: request.intake_mode || "full",
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}

export function createInferredNodeId(featureName, symbol, filePath, nodeMap, classSymbol = null) {
  const featureSafe = featureName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const symbolSafe = symbol.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const classSafe =
    typeof classSymbol === "string" && classSymbol.trim()
      ? classSymbol.replace(/[^a-zA-Z0-9_.-]/g, "_")
      : "no_class";
  const fileSafe =
    typeof filePath === "string" && filePath.trim()
      ? filePath
          .replace(/[\\/]/g, ".")
          .replace(/[^a-zA-Z0-9_.-]/g, "_")
          .replace(/\.+/g, ".")
      : "unknown_file";
  let counter = 1;
  let candidate = `inferred.${featureSafe}.${fileSafe}.${classSafe}.${symbolSafe}`;

  while (nodeMap.has(candidate)) {
    const existing = nodeMap.get(candidate);
    const existingClassSymbol = existing?.metadata?.inferred_class_symbol || null;
    if (existing && existing.symbol === symbol && existing.file === filePath && existingClassSymbol === classSymbol) {
      return candidate;
    }
    counter += 1;
    candidate = `inferred.${featureSafe}.${fileSafe}.${classSafe}.${symbolSafe}.${counter}`;
  }

  return candidate;
}

export function findNodeIdBySymbolAndFile(nodeMap, symbol, filePath, classSymbol = null) {
  if (!symbol || !filePath) {
    return null;
  }

  const expected = sanitizePathForCompare(filePath);
  for (const [nodeId, node] of nodeMap.entries()) {
    if (node.symbol !== symbol) {
      continue;
    }

    const nodeFile = typeof node.file === "string" ? sanitizePathForCompare(node.file) : null;
    if (nodeFile === expected) {
      if (typeof classSymbol === "string" && classSymbol.trim()) {
        const inferredClassSymbol = node?.metadata?.inferred_class_symbol;
        if (typeof inferredClassSymbol === "string" && inferredClassSymbol !== classSymbol) {
          continue;
        }
      }
      return nodeId;
    }
  }

  return null;
}

export async function expandGraphFromOriginsWithAst(graph, request, repositoryRoot) {
  const boundaries = isObject(request.boundaries) ? request.boundaries : {};
  const origins = Array.isArray(boundaries.origins) ? boundaries.origins : [];
  if (origins.length === 0) {
    return {
      expanded_origins: 0,
      skipped_origins: 0,
      inferred_nodes_added: 0,
      inferred_edges_added: 0,
      max_depth_reached: 0,
      truncated: false,
    };
  }

  const nodeMap = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const edgeIdSet = new Set(graph.edges.map((edge) => edge.edge_id));
  const astCache = new Map();
  const resolutionCache = new Map();
  const aliasResolver = await loadTsConfigAliasResolver(repositoryRoot);
  const traversalQueue = [];
  const visitedSymbols = new Set();

  let expandedOrigins = 0;
  let skippedOrigins = 0;
  let inferredNodesAdded = 0;
  let inferredEdgesAdded = 0;
  let maxDepthReached = 0;
  let truncated = false;

  for (const origin of origins) {
    if (!origin || typeof origin.id !== "string" || typeof origin.symbol !== "string") {
      skippedOrigins += 1;
      continue;
    }

    const filePath = origin.evidence?.file;
    if (typeof filePath !== "string" || !filePath.trim()) {
      skippedOrigins += 1;
      continue;
    }

    const originNode = nodeMap.get(origin.id);
    if (!originNode) {
      ensurePlaceholderNode(nodeMap, origin.id, graph.featureName, graph.requestId, origin.evidence);
    }

    const absFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(repositoryRoot, filePath);
    traversalQueue.push({
      origin_id: origin.id,
      node_id: origin.id,
      symbol: origin.symbol,
      class_symbol: null,
      abs_file_path: absFilePath,
      display_file_path: origin.evidence?.file,
      line: origin.evidence?.line,
      depth: 0,
    });
    expandedOrigins += 1;
  }

  while (traversalQueue.length > 0) {
    const current = traversalQueue.shift();
    maxDepthReached = Math.max(maxDepthReached, current.depth);

    if (current.depth >= AST_EXPANSION_MAX_DEPTH) {
      continue;
    }

    const traversalKey = `${current.abs_file_path}::${current.class_symbol || "no_class"}::${current.symbol}::${current.line ?? 0}`;
    if (visitedSymbols.has(traversalKey)) {
      continue;
    }
    visitedSymbols.add(traversalKey);

    let currentFileInfo;
    try {
      currentFileInfo = await loadAstExpansionFileInfo(current.abs_file_path, astCache);
    } catch {
      continue;
    }

    const currentDeclaration = pickBestDeclaration(
      currentFileInfo.declarations,
      current.symbol,
      current.line,
      current.class_symbol || null
    );
    if (!currentDeclaration) {
      continue;
    }

    const callSites = collectCallSitesFromDeclaration(
      currentDeclaration,
      currentFileInfo.sourceFile,
      currentFileInfo.imports,
      currentFileInfo.module_type_hints
    );
    const seenCalls = new Set();

    for (const callSite of callSites) {
      if (inferredEdgesAdded >= AST_EXPANSION_MAX_EDGES) {
        truncated = true;
        break;
      }

      if (callSite.symbol === current.symbol && !callSite.import_binding) {
        continue;
      }

      const callKey = `${callSite.symbol}:${callSite.line}:${callSite.column}:${callSite.import_binding?.module_specifier || "local"}:${callSite.import_binding?.kind || "local"}`;
      if (seenCalls.has(callKey)) {
        continue;
      }
      seenCalls.add(callKey);

      const target = await resolveCallTarget(callSite, currentFileInfo, astCache, resolutionCache, aliasResolver);
      const targetDisplayFilePath = target.target_abs_file_path
        ? toRepoRelativePath(target.target_abs_file_path, repositoryRoot)
        : current.display_file_path;

      let targetNodeId =
        findNodeIdBySymbolAndFile(
          nodeMap,
          target.target_symbol,
          targetDisplayFilePath,
          target.target_class_symbol || null
        ) ||
        findNodeIdBySymbol(nodeMap, target.target_symbol);

      if (!targetNodeId) {
        targetNodeId = createInferredNodeId(
          graph.featureName,
          target.target_symbol,
          targetDisplayFilePath,
          nodeMap,
          target.target_class_symbol || null
        );
        if (!nodeMap.has(targetNodeId)) {
          addOrMergeNode(nodeMap, {
            node_id: targetNodeId,
            kind: "unknown",
            symbol: target.target_symbol,
            file: targetDisplayFilePath,
            line: target.target_declaration?.start_line || callSite.line,
            reason: `AST inferred from symbol '${current.symbol}'.`,
            state: "inferred",
            source: "ast_inferred",
            request_id: graph.requestId,
            feature_name: graph.featureName,
            metadata: {
              inferred_from_origin_id: current.origin_id,
              inferred_from_symbol: current.symbol,
              inferred_via: target.resolved_via,
              inferred_class_symbol: target.target_class_symbol || null,
            },
          });
          inferredNodesAdded += 1;
        }
      }

      const fromFileForEdge = typeof current.display_file_path === "string" ? current.display_file_path : null;
      const edgeId = `ast.${current.node_id}->${targetNodeId}@${fromFileForEdge || "unknown"}:${callSite.line}:${callSite.column}`;
      if (edgeIdSet.has(edgeId)) {
        continue;
      }

      edgeIdSet.add(edgeId);
      graph.edges.push({
        edge_id: edgeId,
        from_node_id: current.node_id,
        to_node_id: targetNodeId,
        edge_type: "ast_calls",
        file: fromFileForEdge,
        line: callSite.line,
        reason: `AST call inferred: ${current.symbol} -> ${target.target_symbol}`,
        state: "inferred",
        source: "ast_inferred",
        request_id: graph.requestId,
        feature_name: graph.featureName,
        metadata: {
          source_group: "ast_calls",
          inferred_from_origin_id: current.origin_id,
          inferred_from_symbol: current.symbol,
          inferred_symbol: target.target_symbol,
          inferred_column: callSite.column,
          inferred_depth: current.depth + 1,
          resolved_via: target.resolved_via,
          inferred_class_symbol: target.target_class_symbol || null,
          resolved_module_specifier: target.resolved_module_specifier || null,
          resolved_by_tsconfig: target.resolved_by_tsconfig || null,
          resolver_scope: target.resolver_scope || null,
        },
      });
      inferredEdgesAdded += 1;

      if (
        target.target_declaration &&
        target.target_abs_file_path &&
        current.depth + 1 < AST_EXPANSION_MAX_DEPTH
      ) {
        traversalQueue.push({
          origin_id: current.origin_id,
          node_id: targetNodeId,
          symbol: target.target_symbol,
          class_symbol: target.target_class_symbol || null,
          abs_file_path: target.target_abs_file_path,
          display_file_path: targetDisplayFilePath,
          line: target.target_declaration.start_line,
          depth: current.depth + 1,
        });
      }
    }
  }

  graph.nodes = Array.from(nodeMap.values());

  return {
    expanded_origins: expandedOrigins,
    skipped_origins: skippedOrigins,
    inferred_nodes_added: inferredNodesAdded,
    inferred_edges_added: inferredEdgesAdded,
    max_depth_reached: maxDepthReached,
    truncated,
  };
}

export function collectEvidenceClaims(boundaries) {
  const claims = [];

  const origins = Array.isArray(boundaries.origins) ? boundaries.origins : [];
  for (const [index, origin] of origins.entries()) {
    claims.push({
      base_path: `boundaries.origins[${index}]`,
      file: origin?.evidence?.file,
      line: origin?.evidence?.line,
      symbol: origin?.symbol,
      symbol_required: true,
    });
  }

  const entrypoints = Array.isArray(boundaries.entrypoints) ? boundaries.entrypoints : [];
  for (const [index, entrypoint] of entrypoints.entries()) {
    claims.push({
      base_path: `boundaries.entrypoints[${index}]`,
      file: entrypoint?.evidence?.file,
      line: entrypoint?.evidence?.line,
      symbol: entrypoint?.symbol,
      symbol_required: true,
    });
  }

  const apiEdges = Array.isArray(boundaries.api_edges) ? boundaries.api_edges : [];
  for (const [index, edge] of apiEdges.entries()) {
    claims.push({
      base_path: `boundaries.api_edges[${index}]`,
      file: edge?.evidence?.file,
      line: edge?.evidence?.line,
      symbol: edge?.symbol,
      symbol_required: true,
    });
  }

  const serviceEdges = Array.isArray(boundaries.service_edges) ? boundaries.service_edges : [];
  for (const [index, edge] of serviceEdges.entries()) {
    claims.push({
      base_path: `boundaries.service_edges[${index}]`,
      file: edge?.evidence?.file,
      line: edge?.evidence?.line,
      symbol: edge?.symbol,
      symbol_required: true,
    });
  }

  const sideEffects = Array.isArray(boundaries.side_effects) ? boundaries.side_effects : [];
  for (const [index, effect] of sideEffects.entries()) {
    claims.push({
      base_path: `boundaries.side_effects[${index}]`,
      file: effect?.evidence?.file,
      line: effect?.evidence?.line,
      symbol: effect?.symbol,
      symbol_required: true,
    });
  }

  return claims;
}

export async function verifyRequestEvidence(request, cwd) {
  const boundaries = isObject(request.boundaries) ? request.boundaries : {};
  const claims = collectEvidenceClaims(boundaries);
  const repositoryRootRaw = request.repository?.root;
  const repositoryRoot =
    typeof repositoryRootRaw === "string" && repositoryRootRaw.trim()
      ? path.resolve(cwd, repositoryRootRaw)
      : cwd;

  const fileCache = new Map();
  const issues = [];

  for (const claim of claims) {
    const filePathValue = claim.file;
    const lineValue = claim.line;
    const symbolValue = claim.symbol;

    if (typeof filePathValue !== "string" || !filePathValue.trim()) {
      issues.push({
        path: `${claim.base_path}.evidence.file`,
        code: "required",
        expected: "existing file path",
        actual: String(filePathValue),
        fix: `Set ${claim.base_path}.evidence.file to a valid path in repository_root.`,
      });
      continue;
    }

    const absFilePath = path.isAbsolute(filePathValue)
      ? filePathValue
      : path.resolve(repositoryRoot, filePathValue);

    let fileInfo;
    try {
      const stat = await fs.stat(absFilePath);
      if (!stat.isFile()) {
        throw new Error("path is not a file");
      }

      fileInfo = await loadFileAstInfo(absFilePath, fileCache);
    } catch (error) {
      issues.push({
        path: `${claim.base_path}.evidence.file`,
        code: "file_not_found",
        expected: "existing readable file",
        actual: absFilePath,
        fix: `Ensure ${claim.base_path}.evidence.file exists under repository_root (${repositoryRoot}).`,
      });
      continue;
    }

    if (!Number.isInteger(lineValue) || lineValue < 1 || lineValue > fileInfo.line_count) {
      issues.push({
        path: `${claim.base_path}.evidence.line`,
        code: "line_out_of_range",
        expected: `integer between 1 and ${fileInfo.line_count}`,
        actual: String(lineValue),
        fix: `Set ${claim.base_path}.evidence.line to a valid line number in ${filePathValue}.`,
      });
    }

    if (claim.symbol_required && (typeof symbolValue !== "string" || !symbolValue.trim())) {
      issues.push({
        path: `${claim.base_path}.symbol`,
        code: "required",
        expected: "non-empty symbol",
        actual: String(symbolValue),
        fix: `Set ${claim.base_path}.symbol to a function/method identifier present in ${filePathValue}.`,
      });
      continue;
    }

    if (typeof symbolValue === "string" && symbolValue.trim()) {
      if (!fileInfo.symbols.has(symbolValue.trim())) {
        issues.push({
          path: `${claim.base_path}.symbol`,
          code: "symbol_not_found",
          expected: "symbol present in AST",
          actual: symbolValue,
          fix: `Use a symbol that exists in ${filePathValue}.`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    repository_root: repositoryRoot,
    checked_claims: claims.length,
    issues,
  };
}

export function summarizeVerificationIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  const byCode = {};
  const byCategory = {
    file: 0,
    line: 0,
    symbol: 0,
    other: 0,
  };
  const bySeverity = {
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const issue of list) {
    const issueCode = typeof issue?.code === "string" && issue.code.trim() ? issue.code.trim() : "unknown";
    byCode[issueCode] = (byCode[issueCode] || 0) + 1;
    bySeverity[mapVerificationIssueSeverity(issueCode)] += 1;

    const issuePath = typeof issue?.path === "string" ? issue.path : "";
    if (issuePath.includes(".evidence.file")) {
      byCategory.file += 1;
    } else if (issuePath.includes(".evidence.line")) {
      byCategory.line += 1;
    } else if (issuePath.endsWith(".symbol")) {
      byCategory.symbol += 1;
    } else {
      byCategory.other += 1;
    }
  }

  return {
    total: list.length,
    by_code: byCode,
    by_category: byCategory,
    by_severity: bySeverity,
  };
}

export function formatVerificationPayload(verification) {
  const issueSummary = summarizeVerificationIssues(verification.issues);
  const confidenceRaw =
    verification.checked_claims > 0
      ? clamp(
          1 -
            (issueSummary.by_severity.high * 0.4 +
              issueSummary.by_severity.medium * 0.22 +
              issueSummary.by_severity.low * 0.1) /
              verification.checked_claims,
          0,
          1
        )
      : 0.35;

  return {
    checked_claims: verification.checked_claims,
    repository_root: verification.repository_root,
    issue_summary: issueSummary,
    verification_confidence: buildConfidencePayload(confidenceRaw),
    issues: verification.issues,
  };
}

export function mapVerificationIssueSeverity(issueCode) {
  switch (issueCode) {
    case "required":
    case "file_not_found":
      return "high";
    case "line_out_of_range":
    case "symbol_not_found":
      return "medium";
    default:
      return "low";
  }
}

export async function buildGraphFromRequestFile(options) {
  const cwd = options.cwd;
  const dbPath = options.dbPath;
  const requestPath = path.resolve(cwd, options.requestPath);

  const payload = await readJsonFile(requestPath);
  const normalizedRequest = normalizeInputRequestShape(payload, cwd);

  const verification = await verifyRequestEvidence(normalizedRequest, cwd);
  const verificationPayload = formatVerificationPayload(verification);
  if (!verification.ok) {
    throw createGraphError("AST_VERIFICATION_FAILED", "AST verification failed before graph build.", {
      ...verificationPayload,
      retry_hint: "Fix file/symbol/line evidence fields and rerun graph build.",
    });
  }

  const graph = buildGraphFromRequest(normalizedRequest);
  const astExpansion = await expandGraphFromOriginsWithAst(
    graph,
    normalizedRequest,
    verificationPayload.repository_root
  );
  const confidenceGate = buildGraphConfidenceGate(graph, options.minConfidenceScore);
  if (options.enforceConfidenceGate && confidenceGate.gate_status === "fail") {
    throw createGraphError(
      "CONFIDENCE_GATE_FAILED",
      "Graph confidence gate failed. More verified evidence is required before build.",
      {
        request_path: requestPath,
        feature: graph.featureName,
        confidence_gate: confidenceGate,
        retry_hint:
          "Add explicit boundary evidence (entrypoints/api_edges/service_edges) or relax gate with --min-confidence.",
      }
    );
  }

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const buildMeta = applyGraphBuild(db, {
      graph,
      requestPath,
      triggerKind: options.triggerKind || "manual",
      triggerDetails: options.triggerDetails || {},
      keepBuilds: options.keepBuilds,
    });

    return {
      status: "ok",
      build_id: buildMeta.build_id,
      pruned_builds: buildMeta.pruned_builds,
      db_path: dbPath,
      request_path: requestPath,
      feature: graph.featureName,
      intake_mode: graph.intakeMode,
      verification: {
        checked_claims: verificationPayload.checked_claims,
        repository_root: verificationPayload.repository_root,
        issue_summary: verificationPayload.issue_summary,
        verification_confidence: verificationPayload.verification_confidence,
      },
      ast_expansion: astExpansion,
      confidence_gate: confidenceGate,
      counts: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
      },
    };
  } finally {
    db.close();
  }
}

export async function verifyGraphRequestFile(options) {
  const cwd = options.cwd;
  const requestPath = path.resolve(cwd, options.requestPath);

  const payload = await readJsonFile(requestPath);
  const normalizedRequest = normalizeInputRequestShape(payload, cwd);
  const verification = await verifyRequestEvidence(normalizedRequest, cwd);
  const verificationPayload = formatVerificationPayload(verification);
  const featureName = typeof normalizedRequest.feature?.name === "string" ? normalizedRequest.feature.name : null;
  const intakeMode = typeof normalizedRequest.intake_mode === "string" ? normalizedRequest.intake_mode : "full";

  if (!verification.ok) {
    return {
      status: "error",
      error_code: "AST_VERIFICATION_FAILED",
      message: "AST verification failed.",
      request_path: requestPath,
      feature: featureName,
      intake_mode: intakeMode,
      ...verificationPayload,
      retry_hint: "Fix file/symbol/line evidence fields and rerun graph verify or graph build.",
    };
  }

  return {
    status: "ok",
    message: "AST verification passed.",
    request_path: requestPath,
    feature: featureName,
    intake_mode: intakeMode,
    ...verificationPayload,
  };
}

export async function exportGraphSnapshot(options) {
  const dbPath = options.dbPath;
  const feature = options.feature;
  const requestedBuildId =
    typeof options.buildId === "string" && options.buildId.trim() ? options.buildId.trim() : null;

  await initGraphDb(dbPath);

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);

    const latestBuild = db
      .prepare(
        `
SELECT build_id, feature_name, request_id, request_path, intake_mode, trigger_kind, trigger_details_json, created_at, node_count, edge_count
FROM builds
WHERE feature_name = @feature_name
ORDER BY created_at DESC, build_id DESC
LIMIT 1;
`
      )
      .get({ feature_name: feature });

    if (!latestBuild) {
      return {
        status: "error",
        error_code: "FEATURE_NOT_FOUND",
        message: `No graph snapshot found for feature '${feature}'.`,
      };
    }

    const selectedBuild = requestedBuildId
      ? db
          .prepare(
            `
SELECT build_id, feature_name, request_id, request_path, intake_mode, trigger_kind, trigger_details_json, created_at, node_count, edge_count
FROM builds
WHERE feature_name = @feature_name AND build_id = @build_id
LIMIT 1;
`
          )
          .get({
            feature_name: feature,
            build_id: requestedBuildId,
          })
      : latestBuild;

    if (!selectedBuild) {
      return {
        status: "error",
        error_code: "BUILD_NOT_FOUND",
        message: `Build '${requestedBuildId}' was not found for feature '${feature}'.`,
        latest_build_id: latestBuild.build_id,
      };
    }

    const nodes = db
      .prepare(
        `
SELECT node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json, created_at
FROM build_nodes
WHERE feature_name = @feature_name AND build_id = @build_id
ORDER BY node_id;
`
      )
      .all({ feature_name: feature, build_id: selectedBuild.build_id })
      .map((row) => ({
        node_id: row.node_id,
        kind: row.kind,
        symbol: row.symbol,
        file: row.file,
        line: row.line,
        reason: row.reason,
        state: row.state,
        source: row.source,
        request_id: row.request_id,
        last_build_id: selectedBuild.build_id,
        metadata: parseJsonObjectSafe(row.metadata_json),
        created_at: row.created_at,
        updated_at: row.created_at,
        ...buildConfidenceFromPairs([
          { state: row.state, source: row.source },
        ]),
      }));

    const nodeById = new Map(nodes.map((node) => [node.node_id, node]));

    const edges = db
      .prepare(
        `
SELECT edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json, created_at
FROM build_edges
WHERE feature_name = @feature_name AND build_id = @build_id
ORDER BY edge_id;
`
      )
      .all({ feature_name: feature, build_id: selectedBuild.build_id })
      .map((row) => ({
        edge_id: row.edge_id,
        from_node_id: row.from_node_id,
        to_node_id: row.to_node_id,
        edge_type: row.edge_type,
        file: row.file,
        line: row.line,
        reason: row.reason,
        state: row.state,
        source: row.source,
        request_id: row.request_id,
        last_build_id: selectedBuild.build_id,
        metadata: parseJsonObjectSafe(row.metadata_json),
        created_at: row.created_at,
        updated_at: row.created_at,
        ...buildConfidenceFromPairs([
          { state: row.state, source: row.source },
          { state: nodeById.get(row.from_node_id)?.state, source: nodeById.get(row.from_node_id)?.source },
          { state: nodeById.get(row.to_node_id)?.state, source: nodeById.get(row.to_node_id)?.source },
        ]),
      }));

    if (nodes.length === 0 && edges.length === 0 && selectedBuild.build_id === latestBuild.build_id) {
      const latestNodes = db
        .prepare(
          `
SELECT node_id, kind, symbol, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at
FROM nodes
WHERE feature_name = @feature_name
ORDER BY node_id;
`
        )
        .all({ feature_name: feature })
        .map((row) => ({
          node_id: row.node_id,
          kind: row.kind,
          symbol: row.symbol,
          file: row.file,
          line: row.line,
          reason: row.reason,
          state: row.state,
          source: row.source,
          request_id: row.request_id,
          last_build_id: row.last_build_id,
          metadata: parseJsonObjectSafe(row.metadata_json),
          created_at: row.created_at,
          updated_at: row.updated_at,
          ...buildConfidenceFromPairs([
            { state: row.state, source: row.source },
          ]),
        }));

      const latestNodeById = new Map(latestNodes.map((node) => [node.node_id, node]));
      const latestEdges = db
        .prepare(
          `
SELECT edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at
FROM edges
WHERE feature_name = @feature_name
ORDER BY edge_id;
`
        )
        .all({ feature_name: feature })
        .map((row) => ({
          edge_id: row.edge_id,
          from_node_id: row.from_node_id,
          to_node_id: row.to_node_id,
          edge_type: row.edge_type,
          file: row.file,
          line: row.line,
          reason: row.reason,
          state: row.state,
          source: row.source,
          request_id: row.request_id,
          last_build_id: row.last_build_id,
          metadata: parseJsonObjectSafe(row.metadata_json),
          created_at: row.created_at,
          updated_at: row.updated_at,
          ...buildConfidenceFromPairs([
            { state: row.state, source: row.source },
            {
              state: latestNodeById.get(row.from_node_id)?.state,
              source: latestNodeById.get(row.from_node_id)?.source,
            },
            {
              state: latestNodeById.get(row.to_node_id)?.state,
              source: latestNodeById.get(row.to_node_id)?.source,
            },
          ]),
        }));

      return {
        status: "ok",
        format_version: SNAPSHOT_FORMAT_VERSION,
        exported_at: new Date().toISOString(),
        db_path: dbPath,
        feature,
        build: {
          build_id: selectedBuild.build_id,
          feature_name: selectedBuild.feature_name,
          request_id: selectedBuild.request_id,
          request_path: selectedBuild.request_path,
          intake_mode: selectedBuild.intake_mode,
          trigger_kind: selectedBuild.trigger_kind,
          trigger_details: parseJsonObjectSafe(selectedBuild.trigger_details_json),
          created_at: selectedBuild.created_at,
          node_count: selectedBuild.node_count,
          edge_count: selectedBuild.edge_count,
        },
        counts: {
          nodes: latestNodes.length,
          edges: latestEdges.length,
        },
        nodes: latestNodes,
        edges: latestEdges,
        snapshot_source: "latest_tables_fallback",
      };
    }

    if (nodes.length === 0 && edges.length === 0) {
      return {
        status: "error",
        error_code: "BUILD_GRAPH_UNAVAILABLE",
        message: `Build '${selectedBuild.build_id}' metadata exists, but no persisted node/edge snapshot is available.`,
        feature,
        build_id: selectedBuild.build_id,
      };
    }

    return {
      status: "ok",
      format_version: SNAPSHOT_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      db_path: dbPath,
      feature,
      build: {
        build_id: selectedBuild.build_id,
        feature_name: selectedBuild.feature_name,
        request_id: selectedBuild.request_id,
        request_path: selectedBuild.request_path,
        intake_mode: selectedBuild.intake_mode,
        trigger_kind: selectedBuild.trigger_kind,
        trigger_details: parseJsonObjectSafe(selectedBuild.trigger_details_json),
        created_at: selectedBuild.created_at,
        node_count: selectedBuild.node_count,
        edge_count: selectedBuild.edge_count,
      },
      counts: {
        nodes: nodes.length,
        edges: edges.length,
      },
      nodes,
      edges,
    };
  } finally {
    db.close();
  }
}

export async function profileGraphWorkflow(options) {
  const startedAt = performance.now();
  const cwd = options.cwd;
  const dbPath = options.dbPath;
  const requestPath = options.requestPath;
  const depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : 6;
  const changedFiles = Array.isArray(options.changedFiles) ? options.changedFiles : [];

  const { PROFILE_TARGETS_MS } = await import("./query.js");

  const verifyStart = performance.now();
  const verifyResult = await verifyGraphRequestFile({
    cwd,
    requestPath,
  });
  const verifyMetrics = evaluateProfileStage(performance.now() - verifyStart, PROFILE_TARGETS_MS.verify);

  if (verifyResult.status === "error") {
    const totalMetrics = evaluateProfileStage(performance.now() - startedAt, PROFILE_TARGETS_MS.total);
    return {
      status: "error",
      error_code: verifyResult.error_code,
      message: verifyResult.message,
      request_path: verifyResult.request_path,
      feature: verifyResult.feature,
      profile: {
        total: totalMetrics,
        stages: {
          verify: verifyMetrics,
        },
        targets_ms: PROFILE_TARGETS_MS,
      },
      verification: verifyResult,
    };
  }

  const buildStart = performance.now();
  const buildResult = await buildGraphFromRequestFile({
    cwd,
    dbPath,
    requestPath,
    keepBuilds: options.keepBuilds,
    triggerKind: "profile",
    triggerDetails: {
      profile_run: true,
    },
  });
  const buildMetrics = evaluateProfileStage(performance.now() - buildStart, PROFILE_TARGETS_MS.build);

  const { queryRisk } = await import("./query.js");

  const riskStart = performance.now();
  const riskResult = await queryRisk({
    cwd,
    dbPath,
    requestPath,
    changedFiles,
    baseRef: options.baseRef,
    headRef: options.headRef,
    depth,
  });
  const riskMetrics = evaluateProfileStage(performance.now() - riskStart, PROFILE_TARGETS_MS.risk);

  const totalMetrics = evaluateProfileStage(performance.now() - startedAt, PROFILE_TARGETS_MS.total);

  return {
    status: "ok",
    db_path: dbPath,
    request_path: path.resolve(cwd, requestPath),
    feature: buildResult.feature,
    profile: {
      total: totalMetrics,
      stages: {
        verify: verifyMetrics,
        build: buildMetrics,
        risk: riskMetrics,
      },
      targets_ms: PROFILE_TARGETS_MS,
      within_target:
        totalMetrics.within_target && verifyMetrics.within_target && buildMetrics.within_target && riskMetrics.within_target,
    },
    verification: {
      checked_claims: verifyResult.checked_claims,
      issue_summary: verifyResult.issue_summary,
      verification_confidence: verifyResult.verification_confidence,
    },
    build: {
      build_id: buildResult.build_id,
      counts: buildResult.counts,
      ast_expansion: buildResult.ast_expansion,
      confidence_gate: buildResult.confidence_gate,
    },
    risk: {
      risk_level: riskResult.risk_level,
      risk_score: riskResult.risk_score,
      risk_reason: riskResult.risk_reason,
      risk_factors: riskResult.risk_factors,
      side_effect_count: riskResult.side_effect_count,
      impacted_node_count: riskResult.impacted_node_count,
      overlap_count: riskResult.overlap_count,
    },
  };
}

function evaluateProfileStage(durationMs, targetMs) {
  return {
    duration_ms: Number(durationMs.toFixed(2)),
    target_ms: targetMs,
    within_target: durationMs <= targetMs,
  };
}
