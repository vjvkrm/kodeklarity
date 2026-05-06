// MCP smoke test: spawns the kk-mcp server against a fixture project and
// exercises every tool. Verifies CLI ↔ MCP parity and that the MCP transport
// works end-to-end. Self-bootstraps so it runs on fresh clones / in CI.

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

// Copy the fixture to an isolated tmp dir per run, so this test cannot race
// against e2e.test.js (which also operates on tests/fixtures/nextjs-drizzle-app)
// when node:test runs files in parallel (the default).
let FIXTURE;

// Each CLI subcommand should have an MCP tool counterpart.
const CLI_TO_MCP = {
  init: "kk_init",
  rebuild: "kk_rebuild",
  impact: "kk_impact",
  upstream: "kk_upstream",
  downstream: "kk_downstream",
  "side-effects": "kk_side_effects",
  why: "kk_why",
  search: "kk_search",
  status: "kk_status",
  precommit: "kk_precommit",
  review: "kk_review",
  "memory write": "kk_memory_write",
  "memory update": "kk_memory_update",
  "memory delete": "kk_memory_delete",
  "memory read": "kk_memory_read",
  "memory search": "kk_memory_search",
  "memory list": "kk_memory_list",
};

before(async () => {
  FIXTURE = await fs.mkdtemp(path.join(os.tmpdir(), "kk-mcp-smoke-"));
  await fs.cp(SOURCE_FIXTURE, FIXTURE, { recursive: true });
  // Don't carry over a stale graph from the source fixture
  await fs.rm(path.join(FIXTURE, ".kodeklarity"), { recursive: true, force: true }).catch(() => {});
  // Initialize as a git repo so kk_review (which resolves a merge-base) can succeed.
  execSync("git init -q -b main", { cwd: FIXTURE });
  execSync("git -c user.email=t@t -c user.name=T add -A", { cwd: FIXTURE });
  execSync("git -c user.email=t@t -c user.name=T commit -q -m initial", { cwd: FIXTURE });
  execSync(`node "${KK_CLI}" init --json`, { cwd: FIXTURE, stdio: "ignore" });
});

after(async () => {
  if (FIXTURE) await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => {});
});

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [KK_MCP],
    cwd: FIXTURE,
  });
  const client = new Client({ name: "smoke-test", version: "0.0.1" }, { capabilities: {} });
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
  const trimmed = txt.trim();
  // Whole-text JSON?
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Some tools prefix a human summary then JSON. Find last "\n{" or "\n[".
  const lastObj = trimmed.lastIndexOf("\n{");
  const lastArr = trimmed.lastIndexOf("\n[");
  const start = Math.max(lastObj, lastArr);
  if (start >= 0) return JSON.parse(trimmed.slice(start + 1));
  throw new Error(`could not parse tool output as JSON: ${trimmed.slice(0, 200)}`);
}

function assertCompactTraversal(j) {
  // MCP traversal tools return compact shape: { status, symbol, total, summary, results, memories? }
  assert.equal(j.status, "ok", `status not ok: ${JSON.stringify(j).slice(0, 200)}`);
  assert.ok(typeof j.total === "number", "expected total to be a number");
  assert.ok(Array.isArray(j.results), "expected results array");
  assert.ok(typeof j.summary === "object", "expected summary object");
}

test("MCP: every CLI command has an MCP tool counterpart", async () => {
  await withClient(async (client) => {
    const list = await client.listTools();
    const names = new Set(list.tools.map((t) => t.name));
    const missing = Object.entries(CLI_TO_MCP)
      .filter(([, mcp]) => !names.has(mcp))
      .map(([cli, mcp]) => `${cli} → ${mcp}`);
    assert.deepEqual(missing, [], `Missing MCP tools: ${missing.join(", ")}`);
  });
});

test("MCP: kk_status returns ok with nodes>0 after init", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_status", arguments: {} });
    const j = readJson(res);
    assert.equal(j.status, "ok", `unexpected: ${JSON.stringify(j)}`);
    assert.ok(typeof j.nodes === "number" && j.nodes > 0, `expected nodes>0, got ${j.nodes}`);
  });
});

test("MCP: kk_search returns matches", async () => {
  await withClient(async (client) => {
    // Search for something common in the nextjs-drizzle fixture.
    const res = await client.callTool({ name: "kk_search", arguments: { term: "users" } });
    const j = readJson(res);
    assert.equal(j.status, "ok");
    assert.ok(Array.isArray(j.matches));
  });
});

test("MCP: kk_impact returns compact shape", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_impact", arguments: { symbol: "users" } });
    const j = readJson(res);
    assertCompactTraversal(j);
  });
});

test("MCP: kk_upstream returns compact shape", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_upstream", arguments: { symbol: "users" } });
    const j = readJson(res);
    assertCompactTraversal(j);
  });
});

test("MCP: kk_downstream returns compact shape", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_downstream", arguments: { symbol: "users" } });
    const j = readJson(res);
    assertCompactTraversal(j);
  });
});

test("MCP: kk_side_effects returns compact shape", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_side_effects", arguments: { symbol: "users" } });
    const j = readJson(res);
    assertCompactTraversal(j);
  });
});

test("MCP: kk_why responds (path or no-path)", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_why", arguments: { from: "users", to: "users" } });
    const j = readJson(res);
    // Either path_found exists, or it errored with an error_code
    assert.ok(j.path_found !== undefined || j.error_code, `unexpected why shape: ${JSON.stringify(j).slice(0, 200)}`);
  });
});

test("MCP: kk_review returns ok with diff_window when --base resolves", async () => {
  await withClient(async (client) => {
    // Use HEAD as the base — merge-base resolves to HEAD itself, valid diff window.
    const res = await client.callTool({ name: "kk_review", arguments: { base: "HEAD" } });
    const j = readJson(res);
    assert.equal(j.status, "ok");
    assert.ok(j.diff_window, "kk_review must include diff_window");
    assert.equal(j.diff_window.base_ref, "HEAD");
  });
});

test("MCP: kk_precommit returns ok", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_precommit", arguments: {} });
    const j = readJson(res);
    assert.equal(j.status, "ok");
    assert.ok(Array.isArray(j.changed_files));
  });
});

test("MCP: kk_rebuild is callable", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "kk_rebuild", arguments: {} });
    const j = readJson(res);
    assert.equal(j.status, "ok");
  });
});

test("MCP: memory write → list → read → search → delete round-trip", async () => {
  await withClient(async (client) => {
    const w = await client.callTool({
      name: "kk_memory_write",
      arguments: { content: "MCP smoke test memory", category: "context" },
    });
    const wj = readJson(w);
    assert.equal(wj.status, "ok");
    const memId = wj.memory_id;
    assert.match(memId, /^mem-/);

    const l = await client.callTool({ name: "kk_memory_list", arguments: { limit: 100 } });
    const lj = readJson(l);
    assert.ok((lj.memories || []).some((m) => m.memory_id === memId), "memory not in list");

    const r = await client.callTool({ name: "kk_memory_read", arguments: {} });
    const rj = readJson(r);
    assert.ok((rj.memories || []).some((m) => m.memory_id === memId), "memory not in read");

    const s = await client.callTool({ name: "kk_memory_search", arguments: { query: "smoke" } });
    const sj = readJson(s);
    assert.ok((sj.memories || []).some((m) => m.memory_id === memId), "memory not in search");

    const d = await client.callTool({ name: "kk_memory_delete", arguments: { memory_ids: [memId] } });
    const dj = readJson(d);
    assert.equal(dj.deleted_count, 1);
  });
});

test("MCP: kk_memory_update modifies content", async () => {
  await withClient(async (client) => {
    const w = await client.callTool({
      name: "kk_memory_write",
      arguments: { content: "before", category: "context" },
    });
    const memId = readJson(w).memory_id;
    try {
      const u = await client.callTool({
        name: "kk_memory_update",
        arguments: { memory_id: memId, content: "after" },
      });
      const uj = readJson(u);
      assert.equal(uj.updated, true);

      const r = await client.callTool({ name: "kk_memory_read", arguments: {} });
      const found = readJson(r).memories.find((m) => m.memory_id === memId);
      assert.equal(found.content, "after");
    } finally {
      await client.callTool({ name: "kk_memory_delete", arguments: { memory_ids: [memId] } });
    }
  });
});

test("MCP: memory survives kk_rebuild (core invariant)", async () => {
  await withClient(async (client) => {
    const w = await client.callTool({
      name: "kk_memory_write",
      arguments: { content: "must survive rebuild", category: "decision" },
    });
    const memId = readJson(w).memory_id;
    try {
      // Force-rebuild and confirm memory still exists
      const rb = await client.callTool({ name: "kk_rebuild", arguments: { force: true } });
      assert.equal(readJson(rb).status, "ok");

      const list = await client.callTool({ name: "kk_memory_list", arguments: { limit: 100 } });
      const found = (readJson(list).memories || []).some((m) => m.memory_id === memId);
      assert.ok(found, "memory was wiped by rebuild — invariant violated!");
    } finally {
      await client.callTool({ name: "kk_memory_delete", arguments: { memory_ids: [memId] } });
    }
  });
});
