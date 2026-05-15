// Tests for `kk memory reset` — clean-slate benchmark command.
// Verifies: confirmation gate, deletion semantics, FTS clearance,
// preservation of nodes/edges, --json output shape.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const KK_CLI = path.join(REPO_ROOT, "dist", "bin", "kk.js");
const SOURCE_FIXTURE = path.join(__dirname, "fixtures", "nextjs-drizzle-app");

let FIXTURE;

function runKk(args, opts = {}) {
  const res = spawnSync(process.execPath, [KK_CLI, ...args], {
    cwd: opts.cwd || FIXTURE,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return {
    code: res.status === null ? 1 : res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

function openDb() {
  // Import the project's better-sqlite3 to read state directly.
  return import("better-sqlite3").then((m) => {
    const Database = m.default;
    const dbPath = path.join(FIXTURE, ".kodeklarity", "index", "graph.sqlite");
    return new Database(dbPath);
  });
}

before(async () => {
  FIXTURE = await fs.mkdtemp(path.join(os.tmpdir(), "kk-mem-reset-"));
  await fs.cp(SOURCE_FIXTURE, FIXTURE, { recursive: true });
  await fs.rm(path.join(FIXTURE, ".kodeklarity"), { recursive: true, force: true }).catch(() => {});
  execSync("git init -q -b main", { cwd: FIXTURE });
  execSync("git -c user.email=t@t -c user.name=T add -A", { cwd: FIXTURE });
  execSync("git -c user.email=t@t -c user.name=T commit -q -m initial", { cwd: FIXTURE });
  // Build the graph once so nodes/edges exist for the preservation check.
  execSync(`node "${KK_CLI}" init --json`, { cwd: FIXTURE, stdio: "ignore" });
});

after(async () => {
  if (FIXTURE) await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => {});
});

async function seedMemories(n) {
  for (let i = 0; i < n; i++) {
    const r = runKk(["memory", "write", `reset test memory ${i} unique_token_${i}`, "--json"]);
    assert.equal(r.code, 0, `seed write failed: ${r.stderr}`);
  }
}

async function countMemories() {
  const db = await openDb();
  try {
    return db.prepare("SELECT COUNT(*) as cnt FROM memories").get().cnt;
  } finally {
    db.close();
  }
}

test("kk memory reset without --yes exits non-zero and deletes nothing", async () => {
  await seedMemories(2);
  const before = await countMemories();
  assert.ok(before >= 2, `expected seeded memories, got ${before}`);

  const r = runKk(["memory", "reset"]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code} (stderr: ${r.stderr})`);
  assert.match(r.stderr, /--yes/i, `expected --yes hint in stderr: ${r.stderr}`);

  const after = await countMemories();
  assert.equal(after, before, "memories were modified despite missing --yes");
});

test("kk memory reset --yes deletes all memories and returns deleted_count", async () => {
  // Ensure at least one memory exists (previous test left some).
  const beforeCount = await countMemories();
  assert.ok(beforeCount > 0, "expected at least one memory to delete");

  const r = runKk(["memory", "reset", "--yes", "--json"]);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code} (stderr: ${r.stderr})`);

  const payload = JSON.parse(r.stdout);
  assert.equal(payload.status, "ok");
  assert.equal(payload.deleted_count, beforeCount);

  const afterCount = await countMemories();
  assert.equal(afterCount, 0, "memories table should be empty after reset");
});

test("after reset, memories table still exists and FTS index is also cleared", async () => {
  // Seed, reset, then query the table and FTS directly.
  await seedMemories(3);
  const r = runKk(["memory", "reset", "--yes", "--json"]);
  assert.equal(r.code, 0, `reset failed: ${r.stderr}`);

  const db = await openDb();
  try {
    // Table still queryable (would throw if dropped).
    const rows = db.prepare("SELECT * FROM memories").all();
    assert.equal(rows.length, 0, "memories table should be empty but still queryable");

    // FTS index also cleared — a MATCH for a known-seeded token returns nothing.
    const ftsHits = db
      .prepare("SELECT COUNT(*) as cnt FROM memories_fts WHERE memories_fts MATCH ?")
      .get("unique_token_0").cnt;
    assert.equal(ftsHits, 0, "FTS index should be cleared after reset");
  } finally {
    db.close();
  }
});

test("reset does not touch nodes or edges tables", async () => {
  // Take a snapshot of node/edge counts.
  const db1 = await openDb();
  const beforeNodes = db1.prepare("SELECT COUNT(*) as cnt FROM nodes").get().cnt;
  const beforeEdges = db1.prepare("SELECT COUNT(*) as cnt FROM edges").get().cnt;
  db1.close();
  assert.ok(beforeNodes > 0, "expected nodes to exist from init");

  await seedMemories(1);
  const r = runKk(["memory", "reset", "--yes", "--json"]);
  assert.equal(r.code, 0, `reset failed: ${r.stderr}`);

  const db2 = await openDb();
  const afterNodes = db2.prepare("SELECT COUNT(*) as cnt FROM nodes").get().cnt;
  const afterEdges = db2.prepare("SELECT COUNT(*) as cnt FROM edges").get().cnt;
  db2.close();
  assert.equal(afterNodes, beforeNodes, "nodes count must be unchanged by memory reset");
  assert.equal(afterEdges, beforeEdges, "edges count must be unchanged by memory reset");
});

test("kk memory reset --yes --json returns parseable JSON with status ok", async () => {
  await seedMemories(2);
  const r = runKk(["memory", "reset", "--yes", "--json"]);
  assert.equal(r.code, 0, `reset failed: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.status, "ok");
  assert.equal(typeof payload.deleted_count, "number");
  assert.ok(payload.deleted_count >= 2);
});

test("writeAgentInstructions writes AGENTS.md (plural) with memory-write triggers", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kk-agent-instr-"));
  try {
    const mod = await import(path.join(REPO_ROOT, "dist", "src", "agent-instructions.js"));
    const written = await mod.writeAgentInstructions(tmp);
    assert.ok(written, "expected file path on first write");
    // Filename is now plural to match the cross-tool community convention
    // (OpenAI Codex, Cursor, Claude Code all read AGENTS.md).
    assert.ok(written.endsWith("AGENTS.md"), `expected AGENTS.md, got ${written}`);
    const contents = await fs.readFile(written, "utf8");
    // Sanity-check the four memory-write triggers and the anti-trigger.
    assert.match(contents, /When to write memory/);
    assert.match(contents, /gotcha/);
    assert.match(contents, /decision/);
    assert.match(contents, /warning/);
    assert.match(contents, /context/);
    assert.match(contents, /Don't write memory for/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
