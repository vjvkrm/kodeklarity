// Shared core for all memory operations.
//
// Both the CLI handlers in src/commands.ts and the MCP tools in src/mcp-server.ts
// delegate to the functions in this file. Keep all SQL and graph-resolution
// logic here so the two surfaces can't drift (that's what caused the
// symbol_path bug — see tests/memory.anchor.test.js for the regression test).
//
// Surface layers are responsible for:
//   - CLI: parse argv, call core, format terminal output (human or --json)
//   - MCP: Zod-validate input, call core, wrap result as JSON in MCP content
//
// Core is responsible for:
//   - Open/close the DB (one connection per call — fine at our scale)
//   - Run migrations
//   - Resolve symbol → node_id via query.resolveNodeReference
//   - Persist symbol_path alongside node_id (the bug class this refactor closes)
//   - Enrich rows with node metadata + stale info so both surfaces benefit
//   - Throw on hard errors; return structured results otherwise

import { randomUUID } from "node:crypto";

const GLOBAL_FEATURE = "__global__";

// Dynamic imports to match the existing pattern in commands.ts / mcp-server.ts.
async function getDbModule() {
  return import("../db.js");
}
async function getQueryModule() {
  return import("../query.js");
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type MemoryCategory = "context" | "gotcha" | "decision" | "warning" | "wiki";

/** Memory row as returned to callers. Mirrors the DB shape plus optional enrichment. */
export interface MemoryRow {
  memory_id: string;
  node_id: string | null;
  edge_id: string | null;
  symbol_path: string | null;
  stale: boolean;
  stale_reason: string | null;
  last_validated_commit_sha: string | null;
  agent: string;
  category: string;
  content: string;
  summary: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
  // Enrichment — populated only when the row's node still exists in the graph.
  node_symbol?: string | null;
  node_kind?: string | null;
  node_file?: string | null;
}

export interface ResolveErrorInfo {
  message: string;
  matches?: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface OpenedDb {
  database: any;
  close: () => void;
}

async function openDb(dbPath: string): Promise<OpenedDb> {
  const db = await getDbModule();
  await db.initGraphDb(dbPath);
  const database = db.openDatabase(dbPath);
  db.runMigrations(database);
  return {
    database,
    close: () => { try { database.close(); } catch { /* ignore */ } },
  };
}

/**
 * Resolve a symbol to a single node_id. Returns either the id or a structured
 * error (ambiguous / not found) so the surface can format an appropriate
 * message. Mirrors mcp-server.ts:resolveSymbol but lives in core.
 */
async function resolveSymbolInner(database: any, symbol: string): Promise<{ nodeId: string | null; error: ResolveErrorInfo | null }> {
  const query = await getQueryModule();
  const result = query.resolveNodeReference(database, GLOBAL_FEATURE, symbol);
  if (result.ok) return { nodeId: result.node.node_id, error: null };
  if (result.error?.code === "ambiguous_reference") {
    return {
      nodeId: null,
      error: {
        message: `Symbol "${symbol}" matches multiple nodes: ${result.error.matches.join(", ")}. Be more specific.`,
        matches: result.error.matches,
      },
    };
  }
  return { nodeId: null, error: { message: `No node found for "${symbol}".` } };
}

/** Annotate a memory row with the persisted stale flag (preferred) or a live node-existence check (fallback). */
function annotateStale(database: any, mem: any): MemoryRow {
  let stale: boolean;
  if (mem.stale === 1 || mem.stale === true) stale = true;
  else if (mem.stale === 0 || mem.stale === false) stale = false;
  else if (mem.node_id) {
    const exists = database
      .prepare("SELECT 1 FROM nodes WHERE feature_name = ? AND node_id = ? LIMIT 1")
      .get(GLOBAL_FEATURE, mem.node_id);
    stale = !exists;
  } else {
    stale = false;
  }
  return {
    memory_id: mem.memory_id,
    node_id: mem.node_id ?? null,
    edge_id: mem.edge_id ?? null,
    symbol_path: mem.symbol_path ?? null,
    stale,
    stale_reason: mem.stale_reason ?? null,
    last_validated_commit_sha: mem.last_validated_commit_sha ?? null,
    agent: mem.agent,
    category: mem.category,
    content: mem.content,
    summary: mem.summary ?? null,
    commit_sha: mem.commit_sha ?? null,
    created_at: mem.created_at,
    updated_at: mem.updated_at,
  };
}

/** Look up node metadata (symbol/kind/file) for enrichment. Returns null fields when node is gone. */
function enrichWithNode(database: any, mem: MemoryRow): MemoryRow {
  if (!mem.node_id) return mem;
  const node = database
    .prepare("SELECT symbol, kind, file FROM nodes WHERE feature_name = ? AND node_id = ?")
    .get(GLOBAL_FEATURE, mem.node_id) as any;
  return {
    ...mem,
    node_symbol: node?.symbol ?? null,
    node_kind: node?.kind ?? null,
    node_file: node?.file ?? null,
  };
}

// ─── Operations ────────────────────────────────────────────────────────────

export interface WriteMemoryInput {
  dbPath: string;
  content: string;
  symbol?: string;
  nodeId?: string;
  edgeId?: string;
  category?: MemoryCategory | string;
  summary?: string;
  agent?: string;
  commitSha?: string;
}
export interface WriteMemoryResult {
  memory_id: string;
  node_id: string | null;
  symbol_path: string | null;
  category: string;
  symbol: string | null;
}

/**
 * Write a memory. If `symbol` is provided, it's resolved to a node_id; the
 * resulting node_id is also persisted as symbol_path so the re-anchor pass
 * on the next rebuild can find this memory deterministically.
 *
 * Throws on ambiguous/unresolved symbols when one was explicitly provided.
 */
export async function writeMemory(input: WriteMemoryInput): Promise<WriteMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    let resolvedNodeId: string | null = input.nodeId ?? null;
    if (!resolvedNodeId && input.symbol) {
      const r = await resolveSymbolInner(database, input.symbol);
      if (r.error) throw new Error(r.error.message);
      resolvedNodeId = r.nodeId;
    }

    // node_id format (kind:file:symbol) is identical to symbol_path — we mirror
    // it so the re-anchor pass has a stable durable anchor.
    const symbolPath = resolvedNodeId;
    const memoryId = `mem-${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const category = input.category || "context";

    database
      .prepare(`
        INSERT INTO memories (
          memory_id, node_id, symbol_path, edge_id, agent, category,
          content, summary, commit_sha, created_at, updated_at
        ) VALUES (
          @memory_id, @node_id, @symbol_path, @edge_id, @agent, @category,
          @content, @summary, @commit_sha, @created_at, @updated_at
        )
      `)
      .run({
        memory_id: memoryId,
        node_id: resolvedNodeId,
        symbol_path: symbolPath,
        edge_id: input.edgeId ?? null,
        agent: input.agent ?? "unknown",
        category,
        content: input.content,
        summary: input.summary ?? null,
        commit_sha: input.commitSha ?? null,
        created_at: now,
        updated_at: now,
      });

    return {
      memory_id: memoryId,
      node_id: resolvedNodeId,
      symbol_path: symbolPath,
      category,
      symbol: input.symbol ?? null,
    };
  } finally {
    close();
  }
}

export interface UpdateMemoryInput {
  dbPath: string;
  memoryId: string;
  content?: string;
  summary?: string;
  category?: string;
  symbol?: string;
  nodeId?: string;
  edgeId?: string;
}
export interface UpdateMemoryResult {
  memory_id: string;
  updated: boolean;
  message?: string;
}

/** Update fields on an existing memory. When `symbol` or `nodeId` changes, symbol_path is kept in sync. */
export async function updateMemory(input: UpdateMemoryInput): Promise<UpdateMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    const existing = database.prepare("SELECT * FROM memories WHERE memory_id = ?").get(input.memoryId);
    if (!existing) {
      throw new Error(`Memory ${input.memoryId} not found`);
    }

    const updates: string[] = [];
    const params: any = { memory_id: input.memoryId };

    if (input.content !== undefined) { updates.push("content = @content"); params.content = input.content; }
    if (input.summary !== undefined) { updates.push("summary = @summary"); params.summary = input.summary; }
    if (input.category !== undefined) { updates.push("category = @category"); params.category = input.category; }

    // If symbol is given (and no explicit nodeId), resolve it.
    let newNodeId: string | null | undefined;
    if (input.nodeId !== undefined) {
      newNodeId = input.nodeId;
    } else if (input.symbol !== undefined) {
      const r = await resolveSymbolInner(database, input.symbol);
      if (r.nodeId) newNodeId = r.nodeId;
      // If symbol doesn't resolve, leave node unchanged silently (mirrors prior
      // MCP behavior).
    }
    if (newNodeId !== undefined) {
      updates.push("node_id = @node_id");
      params.node_id = newNodeId;
      // Keep symbol_path in lockstep (same format as node_id).
      updates.push("symbol_path = @symbol_path");
      params.symbol_path = newNodeId;
    }

    if (input.edgeId !== undefined) {
      updates.push("edge_id = @edge_id");
      params.edge_id = input.edgeId;
    }

    if (updates.length === 0) {
      return { memory_id: input.memoryId, updated: false, message: "No fields to update" };
    }

    updates.push("updated_at = @updated_at");
    params.updated_at = new Date().toISOString();

    database.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE memory_id = @memory_id`).run(params);
    return { memory_id: input.memoryId, updated: true };
  } finally {
    close();
  }
}

export interface DeleteMemoryInput {
  dbPath: string;
  memoryIds: string[];
}
export interface DeleteMemoryResult {
  deleted: string[];
  not_found: string[];
}

export async function deleteMemory(input: DeleteMemoryInput): Promise<DeleteMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    const deleted: string[] = [];
    const notFound: string[] = [];
    const stmt = database.prepare("DELETE FROM memories WHERE memory_id = ?");
    const tx = database.transaction((ids: string[]) => {
      for (const id of ids) {
        const info = stmt.run(id);
        if (info.changes > 0) deleted.push(id);
        else notFound.push(id);
      }
    });
    tx(input.memoryIds);
    return { deleted, not_found: notFound };
  } finally {
    close();
  }
}

export interface ReadMemoryInput {
  dbPath: string;
  symbol?: string;
  nodeId?: string;
  category?: string;
  /** When true, also include memories attached to edges that touch the resolved node(s). MCP default; CLI omits. */
  includeEdgeMemories?: boolean;
  /** Limit only applies when no symbol/nodeId is given (i.e., global memories). */
  limit?: number;
}
export interface ReadMemoryResult {
  symbol: string | null;
  node_ids: string[];
  symbol_not_found: boolean;
  symbol_error?: string;
  memories: MemoryRow[];
}

export async function readMemory(input: ReadMemoryInput): Promise<ReadMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    const nodeIds: string[] = [];
    let symbolNotFound = false;
    let symbolError: string | undefined;

    if (input.nodeId) {
      nodeIds.push(input.nodeId);
    } else if (input.symbol) {
      const r = await resolveSymbolInner(database, input.symbol);
      if (r.nodeId) nodeIds.push(r.nodeId);
      else {
        symbolNotFound = true;
        if (r.error?.matches && r.error.matches.length > 0) symbolError = r.error.message;
      }
    }

    let rows: any[] = [];
    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => "?").join(",");
      const catFilter = input.category ? " AND category = ?" : "";
      const params = [...nodeIds, ...(input.category ? [input.category] : [])];
      rows = database
        .prepare(`SELECT * FROM memories WHERE node_id IN (${placeholders})${catFilter} ORDER BY updated_at DESC`)
        .all(...params);

      if (input.includeEdgeMemories) {
        const edgeRows = database
          .prepare(
            `SELECT m.* FROM memories m JOIN edges e ON m.edge_id = e.edge_id AND e.feature_name = ?
             WHERE (e.from_node_id IN (${placeholders}) OR e.to_node_id IN (${placeholders}))${catFilter}
             ORDER BY m.updated_at DESC`
          )
          .all(GLOBAL_FEATURE, ...nodeIds, ...nodeIds, ...(input.category ? [input.category] : []));
        const seen = new Set(rows.map((m: any) => m.memory_id));
        for (const em of edgeRows) {
          if (!seen.has((em as any).memory_id)) rows.push(em);
        }
      }
    } else if (!symbolNotFound) {
      // No symbol/nodeId — return global memories.
      const catFilter = input.category ? " AND category = ?" : "";
      const limit = input.limit ?? 50;
      const params = [...(input.category ? [input.category] : []), limit];
      rows = database
        .prepare(`SELECT * FROM memories WHERE node_id IS NULL AND edge_id IS NULL${catFilter} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params);
    }

    const memories = rows.map((r) => annotateStale(database, r));
    return {
      symbol: input.symbol ?? null,
      node_ids: nodeIds,
      symbol_not_found: symbolNotFound,
      symbol_error: symbolError,
      memories,
    };
  } finally {
    close();
  }
}

export interface SearchMemoryInput {
  dbPath: string;
  query: string;
  category?: string;
  limit?: number;
  /** When true, include node enrichment (symbol/kind/file). Default true — both surfaces have always wanted this. */
  enrich?: boolean;
}
export interface SearchMemoryResult {
  query: string;
  memories: MemoryRow[];
}

export async function searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    // Prefix matching: "migration" → "migration*" so it matches "migrations".
    const ftsQuery = input.query
      .trim()
      .split(/\s+/)
      .map((w) => `${w}*`)
      .join(" ");
    const catFilter = input.category ? " AND m.category = ?" : "";
    const limit = input.limit ?? 20;
    const params: any[] = [ftsQuery, ...(input.category ? [input.category] : []), limit];

    const rows = database
      .prepare(`
        SELECT m.*, rank
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?${catFilter}
        ORDER BY rank
        LIMIT ?
      `)
      .all(...params) as any[];

    let memories = rows.map((r) => annotateStale(database, r));
    if (input.enrich !== false) memories = memories.map((m) => enrichWithNode(database, m));
    return { query: input.query, memories };
  } finally {
    close();
  }
}

export interface ListMemoryInput {
  dbPath: string;
  category?: string;
  agent?: string;
  limit?: number;
  enrich?: boolean;
}
export interface ListMemoryResult {
  memories: MemoryRow[];
}

export async function listMemories(input: ListMemoryInput): Promise<ListMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    const filters: string[] = [];
    const params: any[] = [];
    if (input.category) { filters.push("category = ?"); params.push(input.category); }
    if (input.agent) { filters.push("agent = ?"); params.push(input.agent); }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = input.limit ?? 50;
    params.push(limit);

    const rows = database
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as any[];

    let memories = rows.map((r) => annotateStale(database, r));
    if (input.enrich !== false) memories = memories.map((m) => enrichWithNode(database, m));
    return { memories };
  } finally {
    close();
  }
}

export interface ListStaleInput {
  dbPath: string;
  limit?: number;
}
export interface ListStaleResult {
  memories: MemoryRow[];
}

export async function listStaleMemories(input: ListStaleInput): Promise<ListStaleResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    const limit = input.limit ?? 50;
    const rows = database
      .prepare(
        `SELECT memory_id, symbol_path, node_id, stale, stale_reason, content, summary, category,
                last_validated_commit_sha, agent, edge_id, commit_sha, created_at, updated_at
         FROM memories WHERE stale = 1 ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as any[];
    const memories = rows.map((r) => annotateStale(database, r));
    return { memories };
  } finally {
    close();
  }
}

export interface ResetMemoryInput {
  dbPath: string;
}
export interface ResetMemoryResult {
  deleted_count: number;
}

/** DELETE FROM memories — table preserved, FTS index cleared via existing trigger. */
export async function resetMemories(input: ResetMemoryInput): Promise<ResetMemoryResult> {
  const { database, close } = await openDb(input.dbPath);
  try {
    const info = database.prepare("DELETE FROM memories").run();
    return { deleted_count: info.changes };
  } finally {
    close();
  }
}
