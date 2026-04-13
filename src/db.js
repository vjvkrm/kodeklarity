import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { isObject, toNullable } from "./utils.js";

export const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";
export const DEFAULT_KEEP_BUILDS = 20;

function ensureColumn(db, tableName, columnDefinition) {
  const columnName = columnDefinition.trim().split(/\s+/)[0];
  const columns = getTableColumns(db, tableName);
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition};`);
  }
}

export const MIGRATIONS = [
  {
    id: "001_initial_graph",
    statements: [
      `
CREATE TABLE IF NOT EXISTS builds (
  build_id TEXT PRIMARY KEY,
  feature_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_path TEXT,
  intake_mode TEXT NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual',
  trigger_details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL
);
`,
      `
CREATE INDEX IF NOT EXISTS idx_builds_feature_created_at
ON builds(feature_name, created_at DESC);
`,
      `
CREATE TABLE IF NOT EXISTS nodes (
  feature_name TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  file TEXT,
  line INTEGER,
  reason TEXT,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  last_build_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (feature_name, node_id)
);
`,
      `
CREATE INDEX IF NOT EXISTS idx_nodes_feature_symbol
ON nodes(feature_name, symbol);
`,
      `
CREATE INDEX IF NOT EXISTS idx_nodes_feature_kind
ON nodes(feature_name, kind);
`,
      `
CREATE TABLE IF NOT EXISTS edges (
  feature_name TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  reason TEXT,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  last_build_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (feature_name, edge_id)
);
`,
      `
CREATE INDEX IF NOT EXISTS idx_edges_feature_from
ON edges(feature_name, from_node_id);
`,
      `
CREATE INDEX IF NOT EXISTS idx_edges_feature_to
ON edges(feature_name, to_node_id);
`,
      `
CREATE INDEX IF NOT EXISTS idx_edges_feature_type
ON edges(feature_name, edge_type);
      `,
    ],
  },
  {
    id: "002_legacy_compat_columns",
    apply: (db) => {
      ensureColumn(db, "builds", "trigger_kind TEXT NOT NULL DEFAULT 'manual'");
      ensureColumn(db, "builds", "trigger_details_json TEXT NOT NULL DEFAULT '{}'");
      ensureColumn(db, "nodes", "last_build_id TEXT NOT NULL DEFAULT 'legacy'");
      ensureColumn(db, "edges", "last_build_id TEXT NOT NULL DEFAULT 'legacy'");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_builds_feature_created_at ON builds(feature_name, created_at DESC);"
      );
    },
  },
  {
    id: "003_build_snapshot_tables",
    statements: [
      `
CREATE TABLE IF NOT EXISTS build_nodes (
  build_id TEXT NOT NULL,
  feature_name TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  file TEXT,
  line INTEGER,
  reason TEXT,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (build_id, node_id),
  FOREIGN KEY (build_id) REFERENCES builds(build_id) ON DELETE CASCADE
);
`,
      `
CREATE INDEX IF NOT EXISTS idx_build_nodes_build
ON build_nodes(build_id);
`,
      `
CREATE INDEX IF NOT EXISTS idx_build_nodes_feature_symbol
ON build_nodes(feature_name, symbol);
`,
      `
CREATE TABLE IF NOT EXISTS build_edges (
  build_id TEXT NOT NULL,
  feature_name TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  reason TEXT,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (build_id, edge_id),
  FOREIGN KEY (build_id) REFERENCES builds(build_id) ON DELETE CASCADE
);
`,
      `
CREATE INDEX IF NOT EXISTS idx_build_edges_build
ON build_edges(build_id);
`,
      `
CREATE INDEX IF NOT EXISTS idx_build_edges_feature_type
ON build_edges(feature_name, edge_type);
`,
    ],
  },
  {
    id: "004_agent_memory",
    statements: [
      `
CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  node_id TEXT,
  edge_id TEXT,
  agent TEXT NOT NULL DEFAULT 'unknown',
  category TEXT NOT NULL DEFAULT 'context',
  content TEXT NOT NULL,
  summary TEXT,
  commit_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
      `CREATE INDEX IF NOT EXISTS idx_memories_node ON memories(node_id);`,
      `CREATE INDEX IF NOT EXISTS idx_memories_edge ON memories(edge_id);`,
      `CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);`,
      `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, summary,
  content='memories', content_rowid='rowid'
);
`,
      `
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary)
  VALUES (NEW.rowid, NEW.content, COALESCE(NEW.summary, ''));
END;
`,
      `
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary)
  VALUES ('delete', OLD.rowid, OLD.content, COALESCE(OLD.summary, ''));
END;
`,
      `
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary)
  VALUES ('delete', OLD.rowid, OLD.content, COALESCE(OLD.summary, ''));
  INSERT INTO memories_fts(rowid, content, summary)
  VALUES (NEW.rowid, NEW.content, COALESCE(NEW.summary, ''));
END;
`,
    ],
  },
];

export function openDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName});`).all();
}

export { ensureColumn };

export function ensureMigrationTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);
}

export function runMigrations(db) {
  ensureMigrationTable(db);

  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1");
  const markApplied = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (@id, @applied_at)"
  );

  for (const migration of MIGRATIONS) {
    const row = isApplied.get(migration.id);
    if (row) {
      continue;
    }

    const apply = db.transaction(() => {
      if (typeof migration.apply === "function") {
        migration.apply(db);
      } else {
        for (const statement of migration.statements || []) {
          db.exec(statement);
        }
      }

      markApplied.run({
        id: migration.id,
        applied_at: new Date().toISOString(),
      });
    });

    apply();
  }
}

export function pruneFeatureBuilds(db, featureName, keepBuilds) {
  if (!Number.isInteger(keepBuilds) || keepBuilds < 1) {
    return 0;
  }

  const rows = db
    .prepare(
      `
SELECT build_id
FROM builds
WHERE feature_name = ?
ORDER BY created_at DESC, build_id DESC;
`
    )
    .all(featureName);

  if (rows.length <= keepBuilds) {
    return 0;
  }

  const toDelete = rows.slice(keepBuilds);
  const deleteStatement = db.prepare("DELETE FROM builds WHERE build_id = ?");

  const prune = db.transaction((buildRows) => {
    for (const row of buildRows) {
      deleteStatement.run(row.build_id);
    }
  });

  prune(toDelete);
  return toDelete.length;
}

export function applyGraphBuild(db, options) {
  const graph = options.graph;
  const requestPath = options.requestPath;
  const triggerKind = options.triggerKind || "manual";
  const triggerDetails = isObject(options.triggerDetails) ? options.triggerDetails : {};
  const keepBuilds =
    Number.isInteger(options.keepBuilds) && options.keepBuilds > 0 ? options.keepBuilds : DEFAULT_KEEP_BUILDS;

  const timestamp = new Date().toISOString();
  const buildId = `build-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const insertBuild = db.prepare(`
INSERT INTO builds (
  build_id, feature_name, request_id, request_path, intake_mode, trigger_kind, trigger_details_json, created_at, node_count, edge_count
)
VALUES (
  @build_id, @feature_name, @request_id, @request_path, @intake_mode, @trigger_kind, @trigger_details_json, @created_at, @node_count, @edge_count
);
`);

  const upsertNode = db.prepare(`
INSERT INTO nodes (
  feature_name, node_id, kind, symbol, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at
)
VALUES (
  @feature_name, @node_id, @kind, @symbol, @file, @line, @reason, @state, @source, @request_id, @last_build_id, @metadata_json, @created_at, @updated_at
)
ON CONFLICT(feature_name, node_id)
DO UPDATE SET
  kind = excluded.kind,
  symbol = COALESCE(excluded.symbol, nodes.symbol),
  file = COALESCE(excluded.file, nodes.file),
  line = COALESCE(excluded.line, nodes.line),
  reason = COALESCE(excluded.reason, nodes.reason),
  state = excluded.state,
  source = excluded.source,
  request_id = excluded.request_id,
  last_build_id = excluded.last_build_id,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at;
`);

  const upsertEdge = db.prepare(`
INSERT INTO edges (
  feature_name, edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at
)
VALUES (
  @feature_name, @edge_id, @from_node_id, @to_node_id, @edge_type, @file, @line, @reason, @state, @source, @request_id, @last_build_id, @metadata_json, @created_at, @updated_at
)
ON CONFLICT(feature_name, edge_id)
DO UPDATE SET
  from_node_id = excluded.from_node_id,
  to_node_id = excluded.to_node_id,
  edge_type = excluded.edge_type,
  file = excluded.file,
  line = excluded.line,
  reason = excluded.reason,
  state = excluded.state,
  source = excluded.source,
  request_id = excluded.request_id,
  last_build_id = excluded.last_build_id,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at;
`);

  const insertBuildNode = db.prepare(`
INSERT INTO build_nodes (
  build_id, feature_name, node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json, created_at
)
VALUES (
  @build_id, @feature_name, @node_id, @kind, @symbol, @file, @line, @reason, @state, @source, @request_id, @metadata_json, @created_at
);
`);

  const insertBuildEdge = db.prepare(`
INSERT INTO build_edges (
  build_id, feature_name, edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json, created_at
)
VALUES (
  @build_id, @feature_name, @edge_id, @from_node_id, @to_node_id, @edge_type, @file, @line, @reason, @state, @source, @request_id, @metadata_json, @created_at
);
`);

  const write = db.transaction(() => {
    db.prepare("DELETE FROM edges WHERE feature_name = ?").run(graph.featureName);
    db.prepare("DELETE FROM nodes WHERE feature_name = ?").run(graph.featureName);

    insertBuild.run({
      build_id: buildId,
      feature_name: graph.featureName,
      request_id: graph.requestId,
      request_path: requestPath,
      intake_mode: graph.intakeMode,
      trigger_kind: triggerKind,
      trigger_details_json: JSON.stringify(triggerDetails),
      created_at: timestamp,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
    });

    for (const node of graph.nodes) {
      upsertNode.run({
        feature_name: node.feature_name,
        node_id: node.node_id,
        kind: node.kind,
        symbol: toNullable(node.symbol),
        file: toNullable(node.file),
        line: toNullable(node.line),
        reason: toNullable(node.reason),
        state: node.state,
        source: node.source,
        request_id: node.request_id,
        last_build_id: buildId,
        metadata_json: JSON.stringify(node.metadata || {}),
        created_at: timestamp,
        updated_at: timestamp,
      });

      insertBuildNode.run({
        build_id: buildId,
        feature_name: node.feature_name,
        node_id: node.node_id,
        kind: node.kind,
        symbol: toNullable(node.symbol),
        file: toNullable(node.file),
        line: toNullable(node.line),
        reason: toNullable(node.reason),
        state: node.state,
        source: node.source,
        request_id: node.request_id,
        metadata_json: JSON.stringify(node.metadata || {}),
        created_at: timestamp,
      });
    }

    for (const edge of graph.edges) {
      upsertEdge.run({
        feature_name: edge.feature_name,
        edge_id: edge.edge_id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        edge_type: edge.edge_type,
        file: toNullable(edge.file),
        line: toNullable(edge.line),
        reason: toNullable(edge.reason),
        state: edge.state,
        source: edge.source,
        request_id: edge.request_id,
        last_build_id: buildId,
        metadata_json: JSON.stringify(edge.metadata || {}),
        created_at: timestamp,
        updated_at: timestamp,
      });

      insertBuildEdge.run({
        build_id: buildId,
        feature_name: edge.feature_name,
        edge_id: edge.edge_id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        edge_type: edge.edge_type,
        file: toNullable(edge.file),
        line: toNullable(edge.line),
        reason: toNullable(edge.reason),
        state: edge.state,
        source: edge.source,
        request_id: edge.request_id,
        metadata_json: JSON.stringify(edge.metadata || {}),
        created_at: timestamp,
      });
    }
  });

  write();

  const prunedBuilds = pruneFeatureBuilds(db, graph.featureName, keepBuilds);

  return {
    build_id: buildId,
    pruned_builds: prunedBuilds,
  };
}

export function applyGraphPatch(db, options) {
  const freshGraph = options.graph;
  const requestPath = options.requestPath;
  const triggerKind = options.triggerKind || "incremental_diff";
  const triggerDetails = isObject(options.triggerDetails) ? options.triggerDetails : {};
  const keepBuilds =
    Number.isInteger(options.keepBuilds) && options.keepBuilds > 0 ? options.keepBuilds : DEFAULT_KEEP_BUILDS;
  const scopeMatcher = options.scopeMatcher;

  if (!scopeMatcher || typeof scopeMatcher.matches !== "function") {
    throw new Error("scopeMatcher.matches is required for incremental patch build");
  }

  const timestamp = new Date().toISOString();
  const buildId = `build-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const existingNodes = db
    .prepare(
      `
SELECT node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json
FROM nodes
WHERE feature_name = @feature_name;
`
    )
    .all({ feature_name: freshGraph.featureName });

  const existingEdges = db
    .prepare(
      `
SELECT edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json
FROM edges
WHERE feature_name = @feature_name;
`
    )
    .all({ feature_name: freshGraph.featureName });

  const existingNodeById = new Map(existingNodes.map((row) => [row.node_id, row]));
  const existingEdgeById = new Map(existingEdges.map((row) => [row.edge_id, row]));
  const freshNodeById = new Map(freshGraph.nodes.map((node) => [node.node_id, node]));
  const freshEdgeById = new Map(freshGraph.edges.map((edge) => [edge.edge_id, edge]));

  const scopedExistingNodeIds = new Set(
    existingNodes.filter((row) => scopeMatcher.matches(row.file, row.line)).map((row) => row.node_id)
  );
  const scopedFreshNodeIds = new Set(
    freshGraph.nodes.filter((row) => scopeMatcher.matches(row.file, row.line)).map((row) => row.node_id)
  );

  const scopedExistingEdgeIds = new Set();
  const scopedFreshEdgeIds = new Set();

  for (const edge of existingEdges) {
    if (
      scopeMatcher.matches(edge.file, edge.line) ||
      scopedExistingNodeIds.has(edge.from_node_id) ||
      scopedExistingNodeIds.has(edge.to_node_id)
    ) {
      scopedExistingEdgeIds.add(edge.edge_id);
      scopedExistingNodeIds.add(edge.from_node_id);
      scopedExistingNodeIds.add(edge.to_node_id);
    }
  }

  for (const edge of freshGraph.edges) {
    if (
      scopeMatcher.matches(edge.file, edge.line) ||
      scopedFreshNodeIds.has(edge.from_node_id) ||
      scopedFreshNodeIds.has(edge.to_node_id)
    ) {
      scopedFreshEdgeIds.add(edge.edge_id);
      scopedFreshNodeIds.add(edge.from_node_id);
      scopedFreshNodeIds.add(edge.to_node_id);
    }
  }

  const upsertNode = db.prepare(`
INSERT INTO nodes (
  feature_name, node_id, kind, symbol, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at
)
VALUES (
  @feature_name, @node_id, @kind, @symbol, @file, @line, @reason, @state, @source, @request_id, @last_build_id, @metadata_json, @created_at, @updated_at
)
ON CONFLICT(feature_name, node_id)
DO UPDATE SET
  kind = excluded.kind,
  symbol = COALESCE(excluded.symbol, nodes.symbol),
  file = COALESCE(excluded.file, nodes.file),
  line = COALESCE(excluded.line, nodes.line),
  reason = COALESCE(excluded.reason, nodes.reason),
  state = excluded.state,
  source = excluded.source,
  request_id = excluded.request_id,
  last_build_id = excluded.last_build_id,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at;
`);

  const upsertEdge = db.prepare(`
INSERT INTO edges (
  feature_name, edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at
)
VALUES (
  @feature_name, @edge_id, @from_node_id, @to_node_id, @edge_type, @file, @line, @reason, @state, @source, @request_id, @last_build_id, @metadata_json, @created_at, @updated_at
)
ON CONFLICT(feature_name, edge_id)
DO UPDATE SET
  from_node_id = excluded.from_node_id,
  to_node_id = excluded.to_node_id,
  edge_type = excluded.edge_type,
  file = excluded.file,
  line = excluded.line,
  reason = excluded.reason,
  state = excluded.state,
  source = excluded.source,
  request_id = excluded.request_id,
  last_build_id = excluded.last_build_id,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at;
`);

  const deleteEdge = db.prepare("DELETE FROM edges WHERE feature_name = @feature_name AND edge_id = @edge_id");
  const deleteNode = db.prepare("DELETE FROM nodes WHERE feature_name = @feature_name AND node_id = @node_id");

  const insertBuild = db.prepare(`
INSERT INTO builds (
  build_id, feature_name, request_id, request_path, intake_mode, trigger_kind, trigger_details_json, created_at, node_count, edge_count
)
VALUES (
  @build_id, @feature_name, @request_id, @request_path, @intake_mode, @trigger_kind, @trigger_details_json, @created_at, @node_count, @edge_count
);
`);

  const insertBuildNode = db.prepare(`
INSERT INTO build_nodes (
  build_id, feature_name, node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json, created_at
)
VALUES (
  @build_id, @feature_name, @node_id, @kind, @symbol, @file, @line, @reason, @state, @source, @request_id, @metadata_json, @created_at
);
`);

  const insertBuildEdge = db.prepare(`
INSERT INTO build_edges (
  build_id, feature_name, edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json, created_at
)
VALUES (
  @build_id, @feature_name, @edge_id, @from_node_id, @to_node_id, @edge_type, @file, @line, @reason, @state, @source, @request_id, @metadata_json, @created_at
);
`);

  const countNodes = db.prepare(
    "SELECT COUNT(*) AS count FROM nodes WHERE feature_name = @feature_name;"
  );
  const countEdges = db.prepare(
    "SELECT COUNT(*) AS count FROM edges WHERE feature_name = @feature_name;"
  );
  const countNodeReferences = db.prepare(
    `
SELECT COUNT(*) AS count
FROM edges
WHERE feature_name = @feature_name
  AND (from_node_id = @node_id OR to_node_id = @node_id);
`
  );

  const readFeatureNodes = db.prepare(
    `
SELECT node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json
FROM nodes
WHERE feature_name = @feature_name
ORDER BY node_id;
`
  );

  const readFeatureEdges = db.prepare(
    `
SELECT edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json
FROM edges
WHERE feature_name = @feature_name
ORDER BY edge_id;
`
  );

  const staleEdgeIds = Array.from(scopedExistingEdgeIds).filter((edgeId) => !scopedFreshEdgeIds.has(edgeId));
  const staleNodeIds = Array.from(scopedExistingNodeIds).filter((nodeId) => !scopedFreshNodeIds.has(nodeId));

  const write = db.transaction(() => {
    for (const nodeId of scopedFreshNodeIds) {
      const node = freshNodeById.get(nodeId);
      if (!node) {
        continue;
      }

      upsertNode.run({
        feature_name: node.feature_name,
        node_id: node.node_id,
        kind: node.kind,
        symbol: toNullable(node.symbol),
        file: toNullable(node.file),
        line: toNullable(node.line),
        reason: toNullable(node.reason),
        state: node.state,
        source: node.source,
        request_id: node.request_id,
        last_build_id: buildId,
        metadata_json: JSON.stringify(node.metadata || {}),
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    for (const edgeId of scopedFreshEdgeIds) {
      const edge = freshEdgeById.get(edgeId);
      if (!edge) {
        continue;
      }

      upsertEdge.run({
        feature_name: edge.feature_name,
        edge_id: edge.edge_id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        edge_type: edge.edge_type,
        file: toNullable(edge.file),
        line: toNullable(edge.line),
        reason: toNullable(edge.reason),
        state: edge.state,
        source: edge.source,
        request_id: edge.request_id,
        last_build_id: buildId,
        metadata_json: JSON.stringify(edge.metadata || {}),
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    for (const edgeId of staleEdgeIds) {
      deleteEdge.run({
        feature_name: freshGraph.featureName,
        edge_id: edgeId,
      });
    }

    for (const nodeId of staleNodeIds) {
      const refs = countNodeReferences.get({
        feature_name: freshGraph.featureName,
        node_id: nodeId,
      });
      if (refs && refs.count > 0) {
        continue;
      }

      deleteNode.run({
        feature_name: freshGraph.featureName,
        node_id: nodeId,
      });
    }

    const nodeCount = countNodes.get({ feature_name: freshGraph.featureName }).count;
    const edgeCount = countEdges.get({ feature_name: freshGraph.featureName }).count;

    insertBuild.run({
      build_id: buildId,
      feature_name: freshGraph.featureName,
      request_id: freshGraph.requestId,
      request_path: requestPath,
      intake_mode: freshGraph.intakeMode,
      trigger_kind: triggerKind,
      trigger_details_json: JSON.stringify(triggerDetails),
      created_at: timestamp,
      node_count: nodeCount,
      edge_count: edgeCount,
    });

    const currentNodes = readFeatureNodes.all({ feature_name: freshGraph.featureName });
    for (const node of currentNodes) {
      insertBuildNode.run({
        build_id: buildId,
        feature_name: freshGraph.featureName,
        node_id: node.node_id,
        kind: node.kind,
        symbol: toNullable(node.symbol),
        file: toNullable(node.file),
        line: toNullable(node.line),
        reason: toNullable(node.reason),
        state: node.state,
        source: node.source,
        request_id: node.request_id,
        metadata_json: node.metadata_json || "{}",
        created_at: timestamp,
      });
    }

    const currentEdges = readFeatureEdges.all({ feature_name: freshGraph.featureName });
    for (const edge of currentEdges) {
      insertBuildEdge.run({
        build_id: buildId,
        feature_name: freshGraph.featureName,
        edge_id: edge.edge_id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        edge_type: edge.edge_type,
        file: toNullable(edge.file),
        line: toNullable(edge.line),
        reason: toNullable(edge.reason),
        state: edge.state,
        source: edge.source,
        request_id: edge.request_id,
        metadata_json: edge.metadata_json || "{}",
        created_at: timestamp,
      });
    }
  });

  write();

  const prunedBuilds = pruneFeatureBuilds(db, freshGraph.featureName, keepBuilds);

  const resultingNodeCount = countNodes.get({ feature_name: freshGraph.featureName }).count;
  const resultingEdgeCount = countEdges.get({ feature_name: freshGraph.featureName }).count;

  return {
    build_id: buildId,
    pruned_builds: prunedBuilds,
    patch_stats: {
      scoped_existing_nodes: scopedExistingNodeIds.size,
      scoped_existing_edges: scopedExistingEdgeIds.size,
      scoped_fresh_nodes: scopedFreshNodeIds.size,
      scoped_fresh_edges: scopedFreshEdgeIds.size,
      deleted_edges: staleEdgeIds.length,
      deleted_nodes: staleNodeIds.length,
      resulting_nodes: resultingNodeCount,
      resulting_edges: resultingEdgeCount,
    },
  };
}

export function resolveDbPath(cwd, dbPathArg) {
  const dbPath = typeof dbPathArg === "string" && dbPathArg.trim() ? dbPathArg.trim() : DEFAULT_DB_PATH;
  return path.resolve(cwd, dbPath);
}

export async function initGraphDb(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }

  return {
    dbPath,
    migration_count: MIGRATIONS.length,
  };
}
