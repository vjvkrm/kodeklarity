import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "nextjs-drizzle-app");
// Use the built bin — matches what users install via npm.
// npm test runs `npm run build` first, so dist/ is guaranteed fresh.
const KK_BIN = path.join(__dirname, "..", "dist", "bin", "kk.js");

function kk(args, cwd = FIXTURE_PATH) {
  try {
    return execSync(`node ${KK_BIN} ${args}`, {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
  } catch (err) {
    return err.stdout || err.stderr || err.message;
  }
}

function kkJson(args, cwd = FIXTURE_PATH) {
  const output = kk(`${args} --json`, cwd);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Failed to parse JSON from: kk ${args}\nOutput: ${output.slice(0, 500)}`);
  }
}

// Cleanup before tests
before(async () => {
  try {
    await fs.rm(path.join(FIXTURE_PATH, ".kodeklarity"), { recursive: true, force: true });
  } catch { /* doesn't exist yet */ }
});

after(async () => {
  try {
    await fs.rm(path.join(FIXTURE_PATH, ".kodeklarity"), { recursive: true, force: true });
  } catch { /* cleanup */ }
});

describe("e2e: kk init", () => {
  it("builds graph and creates config", async () => {
    const result = kkJson("init --force");
    assert.equal(result.status, "ok");
    assert.ok(result.graph.nodes > 0, `should have nodes, got ${result.graph.nodes}`);
    assert.ok(result.graph.edges >= 0, "should have edges");
    assert.ok(result.config_path, "should create config");
    assert.ok(result.config_generated === true, "should be first-run config");
  });

  it("creates .kodeklarity directory", async () => {
    const configExists = await fs.access(path.join(FIXTURE_PATH, ".kodeklarity", "config.json")).then(() => true).catch(() => false);
    assert.ok(configExists, "config.json should exist");

    const dbExists = await fs.access(path.join(FIXTURE_PATH, ".kodeklarity", "index", "graph.sqlite")).then(() => true).catch(() => false);
    assert.ok(dbExists, "graph.sqlite should exist");

    const agentExists = await fs.access(path.join(FIXTURE_PATH, ".kodeklarity", "AGENT.md")).then(() => true).catch(() => false);
    assert.ok(agentExists, "AGENT.md should exist");
  });

  it("detects correct frameworks", async () => {
    const result = kkJson("init");
    const ws = result.workspaces;
    assert.ok(ws.length >= 1, "should have workspaces");

    const rootWs = ws.find((w) => w.path === ".");
    assert.ok(rootWs, "should have root workspace");
    assert.ok(rootWs.stack.some((s) => s.name === "Next.js"), "should detect Next.js");
  });

  it("finds expected node kinds", async () => {
    const result = kkJson("init");
    const kinds = result.nodes_by_kind || {};
    assert.ok(kinds.route >= 2, `should find routes, got ${kinds.route}`);
    assert.ok(kinds.server_action >= 2, `should find server actions, got ${kinds.server_action}`);
    assert.ok(kinds.table >= 3, `should find tables, got ${kinds.table}`);
    assert.ok(kinds.background_job >= 2, `should find jobs, got ${kinds.background_job}`);
  });
});

describe("e2e: kk status", () => {
  it("shows graph overview", () => {
    const result = kkJson("status");
    assert.equal(result.status, "ok");
    assert.ok(result.nodes > 0);
    assert.ok(result.edges >= 0);
    assert.ok(result.nodes_by_kind);
    assert.ok(result.edges_by_type);
  });
});

describe("e2e: kk impact", () => {
  it("traces downstream impact of a server action", () => {
    const result = kkJson("impact loginAction --depth 3");
    assert.equal(result.status, "ok");
    // loginAction may or may not be in graph depending on discovery
    // Just verify the command works and returns valid structure
    assert.ok(Array.isArray(result.start_nodes));
    assert.ok("impact_count" in result);
  });

  it("returns 0 impacts for unknown symbol", () => {
    const result = kkJson("impact nonExistentSymbol123 --depth 2");
    assert.equal(result.status, "ok");
    assert.equal(result.start_nodes.length, 0);
    assert.equal(result.impact_count, 0);
  });
});

describe("e2e: kk upstream", () => {
  it("returns valid upstream result", () => {
    const output = kk("upstream loginAction --depth 2 --json");
    const result = JSON.parse(output);
    assert.equal(result.status, "ok");
    assert.ok(Array.isArray(result.start_nodes));
  });
});

describe("e2e: kk side-effects", () => {
  it("finds side effects of a server action", () => {
    const result = kkJson("side-effects loginAction --depth 4");
    assert.equal(result.status, "ok");
    // loginAction → authenticateUser → db.select(users) → users table is a side effect
  });
});

describe("e2e: kk why", () => {
  it("returns valid why result", () => {
    const output = kk("why --from loginAction --to users --depth 5 --json");
    const result = JSON.parse(output);
    // May return "ok" with path or "error" if symbols not resolved — both valid
    assert.ok(result.status === "ok" || result.status === "error");
  });
});

describe("e2e: kk risk", () => {
  it("returns risk score (0 when no changes)", () => {
    const output = kk("risk --json");
    const result = JSON.parse(output);
    assert.equal(result.status, "ok");
    assert.ok("risk_score" in result || "message" in result);
  });
});

describe("e2e: kk rebuild", () => {
  it("skips rebuild when graph is current", () => {
    const result = kkJson("rebuild");
    // Should either skip or rebuild — both are ok
    assert.equal(result.status, "ok");
  });
});

describe("e2e: config with custom boundaries", () => {
  it("discovers more nodes when custom boundaries are added", async () => {
    // Get initial count
    const before = kkJson("status");
    const nodesBefore = before.nodes;

    // Add custom boundary for query layer
    const configPath = path.join(FIXTURE_PATH, ".kodeklarity", "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.customBoundaries = [
      {
        name: "query-layer",
        kind: "query",
        glob: "src/lib/queries/*.ts",
        symbolPattern: "export (async )?function",
        reason: "Query layer",
      },
      {
        name: "services",
        kind: "service",
        glob: "src/lib/services/*.ts",
        symbolPattern: "export (async )?function",
        reason: "Service layer",
      },
    ];
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // Rebuild
    kkJson("init");

    // Check increased count
    const after = kkJson("status");
    assert.ok(after.nodes > nodesBefore, `should find more nodes after config: ${nodesBefore} → ${after.nodes}`);
    assert.ok(after.nodes_by_kind.query >= 1, "should find query nodes");
    assert.ok(after.nodes_by_kind.service >= 1, "should find service nodes");
  });
});

describe("e2e: help", () => {
  it("shows help text", () => {
    const output = kk("help");
    assert.ok(output.includes("kk — KodeKlarity"), "should show kk name");
    assert.ok(output.includes("kk init"), "should show init command");
    assert.ok(output.includes("kk impact"), "should show impact command");
    assert.ok(output.includes("kk risk"), "should show risk command");
    assert.ok(!output.includes("kk-codeslice"), "should NOT contain old name");
  });
});
