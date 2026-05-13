// Tests for the kk_memory_list_stale MCP tool and `kk memory list-stale` CLI subcommand.
//
// Memories with `stale = 1` are surfaced read-only — never auto-fixed/auto-deleted.
// The pass that actually flips stale=1 lives elsewhere; here we INSERT rows
// directly so we can exercise the surfacing path in isolation.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const KK_MCP = path.join(REPO_ROOT, "dist", "bin", "kk-mcp.js");
const KK_CLI = path.join(REPO_ROOT, "dist", "bin", "kk.js");
const SOURCE_FIXTURE = path.join(__dirname, "fixtures", "nextjs-drizzle-app");

let FIXTURE;
let DB_PATH;

before(async () => {
  FIXTURE = await fs.mkdtemp(path.join(os.tmpdir(), "kk-stale-"));
  await fs.cp(SOURCE_FIXTURE, FIXTURE, { recursive: true });
  await fs.rm(path.join(FIXTURE, ".kodeklarity"), { recursive: true, force: true }).catch(() => {});
  execSync("git init -q -b main", { cwd: FIXTURE });
  execSync("git -c user.email=t@t -c user.name=T add -A", { cwd: FIXTURE });
  execSync("git -c user.email=t@t -c user.name=T commit -q -m initial", { cwd: FIXTURE });
  execSync(`node "${KK_CLI}" init --json`, { cwd: FIXTURE, stdio: "ignore" });
  DB_PATH = path.join(FIXTURE, ".kodeklarity", "index", "graph.sqlite");
});

after(async () => {
  if (FIXTURE) await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => {});
});

async function openDb() {
  const db = await import(path.join(REPO_ROOT, "dist", "src", "db.js"));
  await db.initGraphDb(DB_PATH);
  const database = db.openDatabase(DB_PATH);
  db.runMigrations(database);
  return { db, database };
}

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [KK_MCP],
    cwd: FIXTURE,
  });
  const client = new Client({ name: "list-stale-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function readJson(callResult) {
  const txt = callResult?.content?.[0]?.text;
  assert.ok(typeof txt === "string", `expected text content, got ${JSON.stringify(callResult)}`);
  return JSON.parse(txt.trim());
}

// Clean all rows in memories so each test starts from a known state.
async function clearMemories() {
  const { database } = await openDb();
  try {
    database.prepare("DELETE FROM memories").run();
  } finally {
    database.close();
  }
}

function insertMemory(database, id, stale, opts = {}) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO memories (
      memory_id, node_id, edge_id, agent, category, content, summary, commit_sha,
      created_at, updated_at, symbol_path, stale, stale_reason, last_validated_commit_sha, scope
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.node_id ?? null,
    opts.agent ?? "test",
    opts.category ?? "context",
    opts.content ?? `content for ${id}`,
    opts.summary ?? null,
    now,
    now,
    opts.symbol_path ?? null,
    stale ? 1 : 0,
    opts.stale_reason ?? null,
    opts.last_validated_commit_sha ?? null,
    opts.scope ?? "code"
  );
}

test("kk_memory_list_stale: returns empty list when no stale memories exist", async () => {
  await clearMemories();
  const { database } = await openDb();
  try {
    insertMemory(database, "mem-fresh-1", false, { content: "fresh memory" });
  } finally {
    database.close();
  }

  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_memory_list_stale", arguments: {} });
    const j = readJson(res);
    assert.equal(j.status, "ok");
    assert.equal(j.count, 0);
    assert.deepEqual(j.memories, []);
  });
});

test("kk_memory_list_stale: returns memories with stale=1 only", async () => {
  await clearMemories();
  const { database } = await openDb();
  try {
    insertMemory(database, "mem-fresh-a", false, { content: "still anchored" });
    insertMemory(database, "mem-stale-a", true, {
      symbol_path: "src/old.ts::OldFn",
      stale_reason: "symbol_not_found",
      content: "stale anchor a",
    });
    insertMemory(database, "mem-stale-b", true, {
      symbol_path: "src/old.ts::Renamed",
      stale_reason: "file_deleted",
      content: "stale anchor b",
    });
  } finally {
    database.close();
  }

  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_memory_list_stale", arguments: {} });
    const j = readJson(res);
    assert.equal(j.status, "ok");
    assert.equal(j.count, 2);
    const ids = j.memories.map((m) => m.memory_id).sort();
    assert.deepEqual(ids, ["mem-stale-a", "mem-stale-b"]);
    // Shape includes the expected anchor-durability fields
    const sample = j.memories[0];
    assert.ok("symbol_path" in sample, "symbol_path missing");
    assert.ok("stale_reason" in sample, "stale_reason missing");
    assert.ok("last_validated_commit_sha" in sample, "last_validated_commit_sha missing");
  });
});

test("kk_memory_list_stale: respects the limit parameter", async () => {
  await clearMemories();
  const { database } = await openDb();
  try {
    for (let i = 0; i < 5; i++) {
      insertMemory(database, `mem-stale-${i}`, true, {
        stale_reason: "symbol_not_found",
        content: `stale ${i}`,
      });
    }
  } finally {
    database.close();
  }

  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_memory_list_stale", arguments: { limit: 2 } });
    const j = readJson(res);
    assert.equal(j.status, "ok");
    assert.equal(j.count, 2);
    assert.equal(j.memories.length, 2);
  });
});

test("CLI: kk memory list-stale --json returns structured payload", async () => {
  await clearMemories();
  const { database } = await openDb();
  try {
    insertMemory(database, "mem-cli-stale", true, {
      symbol_path: "src/foo.ts::Bar",
      stale_reason: "symbol_not_found",
      content: "cli stale check",
      summary: "summary line",
    });
    insertMemory(database, "mem-cli-fresh", false, { content: "fresh" });
  } finally {
    database.close();
  }

  const out = execSync(`node "${KK_CLI}" memory list-stale --json`, {
    cwd: FIXTURE,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const j = JSON.parse(out);
  assert.equal(j.status, "ok");
  assert.equal(j.count, 1);
  assert.equal(j.memories[0].memory_id, "mem-cli-stale");
  assert.equal(j.memories[0].symbol_path, "src/foo.ts::Bar");
  assert.equal(j.memories[0].stale_reason, "symbol_not_found");
});

test("CLI: kk memory list-stale prints human-readable output by default", async () => {
  await clearMemories();
  const { database } = await openDb();
  try {
    insertMemory(database, "mem-human-stale", true, {
      symbol_path: "src/foo.ts::Bar",
      stale_reason: "file_deleted",
      content: "human readable stale",
    });
  } finally {
    database.close();
  }

  const out = execSync(`node "${KK_CLI}" memory list-stale`, {
    cwd: FIXTURE,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.match(out, /1 stale memories:/);
  assert.match(out, /mem-human-stale/);
  assert.match(out, /src\/foo\.ts::Bar/);
  assert.match(out, /file_deleted/);
});

test("CLI: kk memory list-stale prints zero-state message when none stale", async () => {
  await clearMemories();
  const { database } = await openDb();
  try {
    insertMemory(database, "mem-only-fresh", false, { content: "fresh" });
  } finally {
    database.close();
  }

  const out = execSync(`node "${KK_CLI}" memory list-stale`, {
    cwd: FIXTURE,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.match(out, /No stale memories found\./);
});
