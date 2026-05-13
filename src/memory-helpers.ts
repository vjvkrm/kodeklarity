import path from "node:path";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";

export function defaultDbPath(cwd = process.cwd()): string {
  return path.join(cwd, DEFAULT_DB_PATH);
}

export interface Memory {
  memory_id: string;
  node_id: string | null;
  edge_id?: string | null;
  agent: string;
  category: string;
  content: string;
  summary: string | null;
  updated_at: string;
  symbol_path?: string | null;
  stale?: number;
  stale_reason?: string | null;
  last_validated_commit_sha?: string | null;
  scope?: string;
}

async function withDb<T>(dbPath: string, fn: (database: any) => T): Promise<T | null> {
  const db = await import("./db.js");
  let database: any;
  try {
    database = db.openDatabase(dbPath);
  } catch {
    return null;
  }
  try {
    return fn(database);
  } catch {
    return null;
  } finally {
    try { database.close(); } catch { /* ignore */ }
  }
}

/** Pull every node_id referenced by a traversal result (impact/upstream/downstream/side-effects/why). */
export function collectNodeIdsFromTraversal(result: any): Set<string> {
  const nodeIds = new Set<string>();
  if (!result) return nodeIds;

  const startNodes = result.start_nodes || [];
  for (const sn of startNodes) {
    if (sn?.node_id) nodeIds.add(sn.node_id);
  }

  const items = result.impacts || result.upstreams || result.side_effects || [];
  for (const item of items) {
    if (item?.from_node_id) nodeIds.add(item.from_node_id);
    if (item?.to_node_id) nodeIds.add(item.to_node_id);
  }

  const paths = result.paths || result.explanation_paths || [];
  for (const p of paths) {
    const steps = p?.steps || p?.edges || [];
    for (const s of steps) {
      if (s?.from_node_id) nodeIds.add(s.from_node_id);
      if (s?.to_node_id) nodeIds.add(s.to_node_id);
    }
  }

  // queryWhy returns a flat top-level `steps` array (single shortest path)
  const flatSteps = Array.isArray(result.steps) ? result.steps : [];
  for (const s of flatSteps) {
    if (s?.from_node_id) nodeIds.add(s.from_node_id);
    if (s?.to_node_id) nodeIds.add(s.to_node_id);
  }

  // queryWhy also exposes resolved endpoints
  if (result.resolved_from_node?.node_id) nodeIds.add(result.resolved_from_node.node_id);
  if (result.resolved_to_node?.node_id) nodeIds.add(result.resolved_to_node.node_id);

  return nodeIds;
}

/** Fetch memories attached to a set of node ids. Empty array if no memories or table missing. */
export async function fetchMemoriesForNodes(dbPath: string, nodeIds: Iterable<string>): Promise<Memory[]> {
  const ids = [...new Set([...nodeIds].filter(Boolean))];
  if (ids.length === 0) return [];
  const result = await withDb(dbPath, (database) => {
    const placeholders = ids.map(() => "?").join(",");
    return database.prepare(
      `SELECT memory_id, node_id, agent, category, content, summary, updated_at,
              symbol_path, stale, stale_reason, last_validated_commit_sha, scope
       FROM memories WHERE node_id IN (${placeholders}) ORDER BY updated_at DESC`
    ).all(...ids) as Memory[];
  });
  return result ?? [];
}

/** Fetch memories from a traversal result (impact/upstream/downstream/side-effects/why). */
export async function fetchMemoriesForTraversal(dbPath: string, result: any): Promise<Memory[]> {
  const nodeIds = collectNodeIdsFromTraversal(result);
  return fetchMemoriesForNodes(dbPath, nodeIds);
}

/** Fetch global (un-attached) memories, optionally filtered by category. */
export async function fetchGlobalMemories(
  dbPath: string,
  options: { categories?: string[]; limit?: number } = {}
): Promise<Memory[]> {
  const limit = options.limit ?? 50;
  const cats = options.categories;
  const result = await withDb(dbPath, (database) => {
    if (cats && cats.length > 0) {
      const placeholders = cats.map(() => "?").join(",");
      return database.prepare(
        `SELECT memory_id, node_id, agent, category, content, summary, updated_at,
                symbol_path, stale, stale_reason, last_validated_commit_sha, scope
         FROM memories WHERE node_id IS NULL AND edge_id IS NULL AND category IN (${placeholders})
         ORDER BY updated_at DESC LIMIT ?`
      ).all(...cats, limit) as Memory[];
    }
    return database.prepare(
      `SELECT memory_id, node_id, agent, category, content, summary, updated_at,
              symbol_path, stale, stale_reason, last_validated_commit_sha, scope
       FROM memories WHERE node_id IS NULL AND edge_id IS NULL
       ORDER BY updated_at DESC LIMIT ?`
    ).all(limit) as Memory[];
  });
  return result ?? [];
}

/** Print a memories block in the human-readable CLI format. */
export function printMemoriesBlock(memories: Memory[], heading = "memories"): void {
  if (!memories || memories.length === 0) return;
  console.log(`  ${heading}: (${memories.length})`);
  for (const m of memories) {
    const tag = m.node_id ? `→ ${m.node_id}` : "(global)";
    console.log(`    ${m.memory_id}  [${m.category}] ${tag}`);
    const oneLine = (m.summary || m.content).split("\n")[0];
    console.log(`      ${oneLine.length > 140 ? oneLine.slice(0, 140) + "…" : oneLine}`);
  }
  console.log("");
}
