// Anchor durability tests for the memory system.
//
// These tests cover the load-bearing pieces of the agent-memory schema:
//   1. Migration 005 is idempotent and adds the right columns.
//   2. Backfill of symbol_path from node_id works for pre-existing rows.
//   3. kk_memory_write captures symbol_path alongside node_id.
//   4. The re-anchor pass in storeDiscoveryResult preserves matching memories
//      and updates last_validated_commit_sha.
//   5. The re-anchor pass flags un-resolvable memories as stale WITHOUT
//      deleting them — the never-wipe invariant must hold.
//
// We exercise the storage layer directly (db.js + store.ts) rather than going
// through the CLI or MCP transport, so failures point at the exact unit under
// test.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DB_MODULE = path.join(REPO_ROOT, "dist", "src", "db.js");
const STORE_MODULE = path.join(REPO_ROOT, "dist", "src", "store.js");

const GLOBAL_FEATURE = "__global__";

async function importBuilt() {
  const db = await import(DB_MODULE);
  const store = await import(STORE_MODULE);
  return { db, store };
}

async function mkTmpDir(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `kk-anchor-${label}-`));
}

function buildDiscoveryResult(repoRoot, nodes = [], edges = []) {
  return {
    repoRoot,
    workspaces: [],
    nodes,
    edges,
    gaps: [],
    stats: {
      filesScanned: 0,
      filesWithBoundaries: 0,
      filesNeedingReview: 0,
      nodesByKind: {},
      edgesByType: {},
    },
  };
}

function memoryRow(database, memoryId) {
  return database
    .prepare("SELECT * FROM memories WHERE memory_id = ?")
    .get(memoryId);
}

test("migration 005 adds the anchor-durability columns and indexes", async () => {
  const { db } = await importBuilt();
  const tmp = await mkTmpDir("mig");
  try {
    const dbPath = path.join(tmp, "graph.sqlite");
    await db.initGraphDb(dbPath);
    const database = db.openDatabase(dbPath);
    try {
      const cols = database.prepare("PRAGMA table_info(memories)").all();
      const names = new Set(cols.map((c) => c.name));
      for (const name of [
        "symbol_path",
        "stale",
        "stale_reason",
        "last_validated_commit_sha",
        "scope",
      ]) {
        assert.ok(names.has(name), `missing column ${name}`);
      }

      // Indexes exist
      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((r) => r.name);
      assert.ok(indexes.includes("idx_memories_symbol_path"));
      assert.ok(indexes.includes("idx_memories_stale"));
      assert.ok(indexes.includes("idx_memories_scope"));
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("migration 005 is idempotent (running migrations twice is a no-op)", async () => {
  const { db } = await importBuilt();
  const tmp = await mkTmpDir("idem");
  try {
    const dbPath = path.join(tmp, "graph.sqlite");
    await db.initGraphDb(dbPath);
    const database = db.openDatabase(dbPath);
    try {
      // Second pass must not throw and must not duplicate columns
      assert.doesNotThrow(() => db.runMigrations(database));
      const cols = database.prepare("PRAGMA table_info(memories)").all();
      const symbolPathCount = cols.filter((c) => c.name === "symbol_path").length;
      assert.equal(symbolPathCount, 1, "symbol_path column duplicated");
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("migration 005 backfills symbol_path from node_id for pre-existing rows", async () => {
  const { db } = await importBuilt();
  const tmp = await mkTmpDir("backfill");
  try {
    const dbPath = path.join(tmp, "graph.sqlite");
    // Apply migrations up through 004 only — simulate an "old" DB at the
    // pre-005 schema, then insert a memory, then apply 005 and check backfill.
    // We do this by running migrations once (which currently includes 005),
    // then dropping the new columns? Simpler: directly manipulate the
    // schema_migrations row for 005 so it re-runs.
    await db.initGraphDb(dbPath);
    const database = db.openDatabase(dbPath);
    try {
      // Insert a memory with node_id but symbol_path NULL — simulate a row
      // that pre-dates the 005 migration's INSERT path.
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO memories (memory_id, node_id, edge_id, agent, category, content, summary, symbol_path, created_at, updated_at)
        VALUES (@id, @node_id, NULL, 'test', 'context', 'pre-migration row', NULL, NULL, @now, @now)
      `).run({ id: "mem-legacy-1", node_id: "action:src/x:foo", now });

      // Re-run the 005 migration body by deleting its row and calling
      // runMigrations again. The UPDATE inside the migration body should
      // backfill symbol_path.
      database.prepare("DELETE FROM schema_migrations WHERE id = ?").run("005_anchor_durability");
      db.runMigrations(database);

      const row = memoryRow(database, "mem-legacy-1");
      assert.equal(row.symbol_path, "action:src/x:foo", "symbol_path not backfilled");
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("storeDiscoveryResult re-anchor preserves matching memories and stamps last_validated_commit_sha", async () => {
  const { db, store } = await importBuilt();
  const tmp = await mkTmpDir("reanchor-ok");
  try {
    const repoRoot = tmp;
    // First build: a single node so the memory has a real anchor.
    const node = {
      id: "action:src/x:foo",
      kind: "action",
      symbol: "foo",
      file: "src/x.ts",
      line: 1,
      reason: "test",
      adapter: "test",
      metadata: {},
    };
    const result1 = buildDiscoveryResult(repoRoot, [node], []);
    const r1 = await store.storeDiscoveryResult(result1, { gitSha: "sha-1" });

    // Insert a memory anchored to that node.
    const database = db.openDatabase(r1.dbPath);
    try {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO memories (memory_id, node_id, edge_id, agent, category, content, summary, symbol_path, created_at, updated_at)
        VALUES (@id, @node_id, NULL, 'test', 'decision', 'remember me', NULL, @sp, @now, @now)
      `).run({ id: "mem-keep-1", node_id: node.id, sp: node.id, now });
    } finally {
      database.close();
    }

    // Second build with the SAME node + a new git sha. Re-anchor should
    // resolve cleanly and stamp last_validated_commit_sha.
    const result2 = buildDiscoveryResult(repoRoot, [node], []);
    await store.storeDiscoveryResult(result2, { gitSha: "sha-2" });

    const database2 = db.openDatabase(r1.dbPath);
    try {
      const row = memoryRow(database2, "mem-keep-1");
      assert.ok(row, "memory was wiped — invariant violated");
      assert.equal(row.stale, 0, "memory was incorrectly flagged stale");
      assert.equal(row.stale_reason, null);
      assert.equal(row.last_validated_commit_sha, "sha-2");
      assert.equal(row.node_id, node.id);
      assert.equal(row.content, "remember me", "content was lost");
    } finally {
      database2.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("storeDiscoveryResult re-anchor flags missing anchors as stale (no delete)", async () => {
  const { db, store } = await importBuilt();
  const tmp = await mkTmpDir("reanchor-stale");
  try {
    const repoRoot = tmp;
    const node = {
      id: "action:src/x:foo",
      kind: "action",
      symbol: "foo",
      file: "src/x.ts",
      line: 1,
      reason: "test",
      adapter: "test",
      metadata: {},
    };
    const result1 = buildDiscoveryResult(repoRoot, [node], []);
    const r1 = await store.storeDiscoveryResult(result1, { gitSha: "sha-1" });

    const database = db.openDatabase(r1.dbPath);
    try {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO memories (memory_id, node_id, edge_id, agent, category, content, summary, symbol_path, created_at, updated_at)
        VALUES (@id, @node_id, NULL, 'test', 'gotcha', 'fragile bit', NULL, @sp, @now, @now)
      `).run({ id: "mem-stale-1", node_id: node.id, sp: node.id, now });
    } finally {
      database.close();
    }

    // Second build with NO nodes — the anchor is gone.
    const result2 = buildDiscoveryResult(repoRoot, [], []);
    await store.storeDiscoveryResult(result2, { gitSha: "sha-2" });

    const database2 = db.openDatabase(r1.dbPath);
    try {
      const row = memoryRow(database2, "mem-stale-1");
      assert.ok(row, "stale memory was incorrectly deleted — invariant violated");
      assert.equal(row.stale, 1, "memory should be flagged stale");
      assert.equal(row.stale_reason, "unresolved");
      assert.equal(row.content, "fragile bit", "content must be preserved");
      // last_validated_commit_sha NOT updated on stale path
      assert.notEqual(row.last_validated_commit_sha, "sha-2");
    } finally {
      database2.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("re-anchor can rescue a memory: stale → resolved when the symbol reappears", async () => {
  const { db, store } = await importBuilt();
  const tmp = await mkTmpDir("rescue");
  try {
    const repoRoot = tmp;
    const node = {
      id: "action:src/x:foo",
      kind: "action",
      symbol: "foo",
      file: "src/x.ts",
      line: 1,
      reason: "test",
      adapter: "test",
      metadata: {},
    };
    // Build 1: node present, memory anchored.
    const r1 = await store.storeDiscoveryResult(
      buildDiscoveryResult(repoRoot, [node], []),
      { gitSha: "sha-1" }
    );
    const database = db.openDatabase(r1.dbPath);
    try {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO memories (memory_id, node_id, edge_id, agent, category, content, summary, symbol_path, created_at, updated_at)
        VALUES (@id, @node_id, NULL, 'test', 'context', 'rescue me', NULL, @sp, @now, @now)
      `).run({ id: "mem-rescue-1", node_id: node.id, sp: node.id, now });
    } finally {
      database.close();
    }

    // Build 2: anchor gone → stale.
    await store.storeDiscoveryResult(
      buildDiscoveryResult(repoRoot, [], []),
      { gitSha: "sha-2" }
    );
    // Build 3: anchor reappears → memory resolved again.
    await store.storeDiscoveryResult(
      buildDiscoveryResult(repoRoot, [node], []),
      { gitSha: "sha-3" }
    );

    const database3 = db.openDatabase(r1.dbPath);
    try {
      const row = memoryRow(database3, "mem-rescue-1");
      assert.equal(row.stale, 0, "memory should have been re-anchored");
      assert.equal(row.stale_reason, null);
      assert.equal(row.last_validated_commit_sha, "sha-3");
    } finally {
      database3.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

// Regression: `kk memory write --node <symbol>` (the CLI path, not the MCP path)
// must persist symbol_path alongside node_id. Without it, memories created via
// the CLI are invisible to the re-anchor pass — they never get re-validated on
// rebuild and never get flagged stale when their symbol disappears.
//
// Original bug: handleMemoryWrite in src/commands.ts inserted node_id but
// omitted symbol_path. The MCP write path had it; the CLI write path didn't.
// Fixed in commit b6df805 area. This test exercises handleMemory(['write',...])
// directly (no subprocess) and asserts the row carries symbol_path = node_id.
test("regression: CLI handleMemory('write') persists symbol_path alongside node_id", async () => {
  const COMMANDS_MODULE = path.join(REPO_ROOT, "dist", "src", "commands.js");
  const { db } = await importBuilt();
  const commands = await import(COMMANDS_MODULE);
  const tmp = await mkTmpDir("cli-write");
  try {
    const dbPath = path.join(tmp, "graph.sqlite");
    await db.initGraphDb(dbPath);

    // Seed a synthetic node so the CLI's symbol resolver finds something.
    // node_id format (kind:file:symbol) matches what makeNodeId produces.
    const database = db.openDatabase(dbPath);
    const NODE_ID = "action:src/x:foo";
    try {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO nodes (
          feature_name, node_id, kind, symbol, file, line, reason, state, source,
          request_id, last_build_id, metadata_json, created_at, updated_at
        ) VALUES (
          @feature_name, @node_id, @kind, @symbol, @file, @line, @reason, 'verified', 'test',
          'test', 'test-build', '{}', @now, @now
        )
      `).run({
        feature_name: GLOBAL_FEATURE,
        node_id: NODE_ID,
        kind: "action",
        symbol: "foo",
        file: "src/x.ts",
        line: 1,
        reason: "regression test fixture",
        now,
      });
    } finally {
      database.close();
    }

    // Silence the CLI's stdout/stderr for the duration of the call so test
    // output stays clean. We're only asserting on DB state.
    const realLog = console.log;
    const realErr = console.error;
    console.log = () => {};
    console.error = () => {};
    let exitCode;
    try {
      exitCode = await commands.handleMemory([
        "write",
        "we retry 3x because of upstream rate limits",
        "--node", "foo",
        "--category", "gotcha",
        "--db-path", dbPath,
        "--json",
      ]);
    } finally {
      console.log = realLog;
      console.error = realErr;
    }

    assert.equal(exitCode, 0, "handleMemory write should succeed");

    // The regression check: the inserted memory must carry symbol_path.
    const database2 = db.openDatabase(dbPath);
    try {
      const row = database2
        .prepare("SELECT node_id, symbol_path FROM memories ORDER BY created_at DESC LIMIT 1")
        .get();
      assert.ok(row, "memory row not found");
      assert.equal(row.node_id, NODE_ID, "node_id should resolve to the seeded symbol");
      assert.equal(
        row.symbol_path,
        NODE_ID,
        "symbol_path must be persisted on CLI write (regression — was NULL before fix)"
      );
    } finally {
      database2.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
