import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { DiscoveryResult, BoundaryNode, BoundaryEdge } from "./discover/index.js";

// Use dynamic import for the JS db module
async function getDb() {
  const db = await import("./db.js");
  return db;
}

const GLOBAL_FEATURE = "__global__";
const DEFAULT_DB_DIR = ".kodeklarity/index";
const DEFAULT_DB_NAME = "graph.sqlite";

export interface StoreResult {
  dbPath: string;
  buildId: string;
  nodesStored: number;
  edgesStored: number;
  gitSha: string | null;
}

export async function storeDiscoveryResult(
  result: DiscoveryResult,
  options: {
    dbPath?: string;
    gitSha?: string | null;
    gitBranch?: string | null;
    keepBuilds?: number;
  } = {}
): Promise<StoreResult> {
  const db = await getDb();

  const dbDir = path.join(result.repoRoot, DEFAULT_DB_DIR);
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = options.dbPath || path.join(dbDir, DEFAULT_DB_NAME);

  await db.initGraphDb(dbPath);
  const database = db.openDatabase(dbPath);

  try {
    db.runMigrations(database);

    // Add git_sha migration if not exists
    ensureGitShaColumn(database);

    const buildId = `init-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const requestId = `discovery-${Date.now()}`;

    // Convert discovery nodes to graph format
    const graphNodes = result.nodes.map((node) => ({
      node_id: node.id,
      kind: node.kind,
      symbol: node.symbol,
      file: node.file,
      line: node.line,
      reason: node.reason,
      state: "verified",
      source: "discovery",
      request_id: requestId,
      feature_name: GLOBAL_FEATURE,
      metadata: node.metadata || {},
    }));

    const graphEdges = result.edges.map((edge, i) => ({
      edge_id: `disc.${i + 1}:${edge.from}->${edge.to}`,
      from_node_id: edge.from,
      to_node_id: edge.to,
      edge_type: edge.edgeType,
      file: edge.file,
      line: edge.line,
      reason: edge.reason,
      state: "verified",
      source: "discovery",
      request_id: requestId,
      feature_name: GLOBAL_FEATURE,
      metadata: edge.metadata || {},
    }));

    // Use transaction for atomic write
    const insertBuild = database.prepare(`
      INSERT INTO builds (build_id, feature_name, request_id, request_path, intake_mode, trigger_kind, trigger_details_json, created_at, node_count, edge_count)
      VALUES (@build_id, @feature_name, @request_id, @request_path, @intake_mode, @trigger_kind, @trigger_details_json, @created_at, @node_count, @edge_count)
    `);

    const upsertNode = database.prepare(`
      INSERT INTO nodes (feature_name, node_id, kind, symbol, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at)
      VALUES (@feature_name, @node_id, @kind, @symbol, @file, @line, @reason, @state, @source, @request_id, @last_build_id, @metadata_json, @created_at, @updated_at)
      ON CONFLICT(feature_name, node_id) DO UPDATE SET
        kind = @kind, symbol = @symbol, file = @file, line = @line, reason = @reason,
        state = @state, source = @source, last_build_id = @last_build_id,
        metadata_json = @metadata_json, updated_at = @updated_at
    `);

    const upsertEdge = database.prepare(`
      INSERT INTO edges (feature_name, edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, last_build_id, metadata_json, created_at, updated_at)
      VALUES (@feature_name, @edge_id, @from_node_id, @to_node_id, @edge_type, @file, @line, @reason, @state, @source, @request_id, @last_build_id, @metadata_json, @created_at, @updated_at)
      ON CONFLICT(feature_name, edge_id) DO UPDATE SET
        from_node_id = @from_node_id, to_node_id = @to_node_id, edge_type = @edge_type,
        file = @file, line = @line, reason = @reason, state = @state, source = @source,
        last_build_id = @last_build_id, metadata_json = @metadata_json, updated_at = @updated_at
    `);

    const insertBuildNode = database.prepare(`
      INSERT OR REPLACE INTO build_nodes (build_id, feature_name, node_id, kind, symbol, file, line, reason, state, source, request_id, metadata_json, created_at)
      VALUES (@build_id, @feature_name, @node_id, @kind, @symbol, @file, @line, @reason, @state, @source, @request_id, @metadata_json, @created_at)
    `);

    const insertBuildEdge = database.prepare(`
      INSERT OR REPLACE INTO build_edges (build_id, feature_name, edge_id, from_node_id, to_node_id, edge_type, file, line, reason, state, source, request_id, metadata_json, created_at)
      VALUES (@build_id, @feature_name, @edge_id, @from_node_id, @to_node_id, @edge_type, @file, @line, @reason, @state, @source, @request_id, @metadata_json, @created_at)
    `);

    const transaction = database.transaction(() => {
      // Clear existing global nodes/edges for clean rebuild
      database.prepare("DELETE FROM nodes WHERE feature_name = ?").run(GLOBAL_FEATURE);
      database.prepare("DELETE FROM edges WHERE feature_name = ?").run(GLOBAL_FEATURE);

      // Insert build record
      insertBuild.run({
        build_id: buildId,
        feature_name: GLOBAL_FEATURE,
        request_id: requestId,
        request_path: null,
        intake_mode: "discovery",
        trigger_kind: "kk_init",
        trigger_details_json: JSON.stringify({
          workspaces: result.workspaces.map((ws) => ws.relativePath),
          git_sha: options.gitSha || null,
        }),
        created_at: now,
        node_count: graphNodes.length,
        edge_count: graphEdges.length,
      });

      // Insert nodes
      for (const node of graphNodes) {
        const params = {
          feature_name: GLOBAL_FEATURE,
          node_id: node.node_id,
          kind: node.kind,
          symbol: node.symbol,
          file: node.file,
          line: node.line,
          reason: node.reason,
          state: node.state,
          source: node.source,
          request_id: node.request_id,
          last_build_id: buildId,
          metadata_json: JSON.stringify(node.metadata),
          created_at: now,
          updated_at: now,
        };
        upsertNode.run(params);
        insertBuildNode.run({
          build_id: buildId,
          ...params,
        });
      }

      // Insert edges
      for (const edge of graphEdges) {
        const params = {
          feature_name: GLOBAL_FEATURE,
          edge_id: edge.edge_id,
          from_node_id: edge.from_node_id,
          to_node_id: edge.to_node_id,
          edge_type: edge.edge_type,
          file: edge.file,
          line: edge.line,
          reason: edge.reason,
          state: edge.state,
          source: edge.source,
          request_id: edge.request_id,
          last_build_id: buildId,
          metadata_json: JSON.stringify(edge.metadata),
          created_at: now,
          updated_at: now,
        };
        upsertEdge.run(params);
        insertBuildEdge.run({
          build_id: buildId,
          ...params,
        });
      }

      // Store git state
      if (options.gitSha) {
        database.prepare(
          "INSERT OR REPLACE INTO kv (key, value) VALUES ('last_build_sha', @v)"
        ).run({ v: options.gitSha });
      }
      if (options.gitBranch) {
        database.prepare(
          "INSERT OR REPLACE INTO kv (key, value) VALUES ('last_build_branch', @v)"
        ).run({ v: options.gitBranch });
      }
      database.prepare(
        "INSERT OR REPLACE INTO kv (key, value) VALUES ('last_build_at', @v)"
      ).run({ v: now });

      // Prune old builds
      db.pruneFeatureBuilds(database, GLOBAL_FEATURE, options.keepBuilds ?? 5);
    });

    transaction();

    return {
      dbPath,
      buildId,
      nodesStored: graphNodes.length,
      edgesStored: graphEdges.length,
      gitSha: options.gitSha ?? null,
    };
  } finally {
    database.close();
  }
}

function ensureGitShaColumn(database: any): void {
  // Create a simple kv table for metadata like git SHA
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

export interface BuildInfo {
  sha: string | null;
  branch: string | null;
  builtAt: string | null;
}

export async function getLastBuildInfo(dbPath: string): Promise<BuildInfo> {
  const db = await getDb();
  try {
    const database = db.openDatabase(dbPath);
    try {
      const getKv = (key: string) => {
        try {
          const row = database.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
          return row?.value ?? null;
        } catch { return null; }
      };
      return {
        sha: getKv("last_build_sha"),
        branch: getKv("last_build_branch"),
        builtAt: getKv("last_build_at"),
      };
    } finally {
      database.close();
    }
  } catch {
    return { sha: null, branch: null, builtAt: null };
  }
}
