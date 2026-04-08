import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "nextjs-drizzle-app");

let discover, detectWorkspaces, detectStack, getAdapter;

before(async () => {
  const discoverMod = await import("../dist/src/discover/index.js");
  discover = discoverMod.discover;
  const wsMod = await import("../dist/src/discover/workspace.js");
  detectWorkspaces = wsMod.detectWorkspaces;
  const detMod = await import("../dist/src/discover/detector.js");
  detectStack = detMod.detectStack;
  getAdapter = detMod.getAdapter;
});

describe("workspace detection", () => {
  it("detects monorepo with workspaces", async () => {
    const result = await detectWorkspaces(FIXTURE_PATH);
    assert.ok(result.workspaces.length >= 1, "should find at least 1 workspace");
    const dbWorkspace = result.workspaces.find((ws) => ws.relativePath === "packages/db");
    assert.ok(dbWorkspace, "should find packages/db workspace");
  });

  it("includes root as workspace when it has src/app", async () => {
    const result = await detectWorkspaces(FIXTURE_PATH);
    const rootWs = result.workspaces.find((ws) => ws.relativePath === ".");
    assert.ok(rootWs, "should include root workspace");
  });
});

describe("stack detection", () => {
  it("detects Next.js from package.json", async () => {
    const result = await detectWorkspaces(FIXTURE_PATH);
    // Find any workspace that has Next.js deps (root or otherwise)
    let foundNextjs = false;
    for (const ws of result.workspaces) {
      const stack = detectStack(ws);
      if (stack.find((s) => s.adapter === "nextjs")) { foundNextjs = true; break; }
    }
    assert.ok(foundNextjs, "should detect Next.js in at least one workspace");
  });

  it("detects Drizzle from package.json", async () => {
    const result = await detectWorkspaces(FIXTURE_PATH);
    let found = false;
    for (const ws of result.workspaces) {
      const stack = detectStack(ws);
      if (stack.find((s) => s.adapter === "drizzle")) { found = true; break; }
    }
    assert.ok(found, "should detect Drizzle in at least one workspace");
  });

  it("detects Trigger.dev from package.json", async () => {
    const result = await detectWorkspaces(FIXTURE_PATH);
    let found = false;
    for (const ws of result.workspaces) {
      const stack = detectStack(ws);
      if (stack.find((s) => s.adapter === "triggerdev")) { found = true; break; }
    }
    assert.ok(found, "should detect Trigger.dev in at least one workspace");
  });
});

describe("framework adapters", () => {
  async function getRootWorkspace() {
    const result = await detectWorkspaces(FIXTURE_PATH);
    // Prefer root, fall back to first workspace with Next.js deps
    return result.workspaces.find((ws) => ws.relativePath === ".") || result.workspaces[0];
  }

  it("nextjs adapter finds pages", async () => {
    const adapter = getAdapter("nextjs");
    const ws = await getRootWorkspace();
    assert.ok(ws, "should have a workspace");
    const scan = await adapter.scan(ws, FIXTURE_PATH);
    const routes = scan.nodes.filter((n) => n.kind === "route");
    assert.ok(routes.length >= 2, `should find pages, found ${routes.length}`);
  });

  it("nextjs adapter finds API routes", async () => {
    const adapter = getAdapter("nextjs");
    const ws = await getRootWorkspace();
    const scan = await adapter.scan(ws, FIXTURE_PATH);
    const apiRoutes = scan.nodes.filter((n) => n.kind === "api_route");
    assert.ok(apiRoutes.length >= 1, `should find API routes, found ${apiRoutes.length}`);
  });

  it("nextjs adapter finds server actions", async () => {
    const adapter = getAdapter("nextjs");
    const ws = await getRootWorkspace();
    const scan = await adapter.scan(ws, FIXTURE_PATH);
    const actions = scan.nodes.filter((n) => n.kind === "server_action");
    assert.ok(actions.length >= 2, `should find server actions, found ${actions.length}`);
    const loginAction = actions.find((a) => a.symbol === "loginAction");
    assert.ok(loginAction, "should find loginAction");
  });

  it("nextjs adapter finds revalidation edges", async () => {
    const adapter = getAdapter("nextjs");
    const ws = await getRootWorkspace();
    const scan = await adapter.scan(ws, FIXTURE_PATH);
    const revalidateEdges = scan.edges.filter((e) => e.edgeType === "revalidates");
    assert.ok(revalidateEdges.length >= 1, `should find revalidation edges, found ${revalidateEdges.length}`);
  });

  it("nextjs adapter finds middleware", async () => {
    const adapter = getAdapter("nextjs");
    const ws = await getRootWorkspace();
    const scan = await adapter.scan(ws, FIXTURE_PATH);
    const middleware = scan.nodes.filter((n) => n.kind === "middleware");
    assert.ok(middleware.length >= 1, "should find middleware");
  });

  it("drizzle adapter finds tables", async () => {
    const adapter = getAdapter("drizzle");
    const result = await detectWorkspaces(FIXTURE_PATH);
    const dbWs = result.workspaces.find((ws) => ws.relativePath === "packages/db");
    assert.ok(dbWs, "db workspace should exist");
    const scan = await adapter.scan(dbWs, FIXTURE_PATH);
    const tables = scan.nodes.filter((n) => n.kind === "table");
    assert.ok(tables.length >= 3, `should find 3 tables (users, posts, comments), found ${tables.length}`);
    assert.ok(tables.find((t) => t.symbol === "users"), "should find users table");
    assert.ok(tables.find((t) => t.symbol === "posts"), "should find posts table");
    assert.ok(tables.find((t) => t.symbol === "comments"), "should find comments table");
  });

  it("triggerdev adapter finds jobs", async () => {
    const adapter = getAdapter("triggerdev");
    const result = await detectWorkspaces(FIXTURE_PATH);
    const rootWs = result.workspaces.find((ws) => ws.relativePath === ".");
    const scan = await adapter.scan(rootWs, FIXTURE_PATH);
    const jobs = scan.nodes.filter((n) => n.kind === "background_job");
    assert.ok(jobs.length >= 2, `should find 2 jobs, found ${jobs.length}`);
    assert.ok(jobs.find((j) => j.symbol === "sync-users"), "should find sync-users job");
    assert.ok(jobs.find((j) => j.symbol === "cleanup-old-posts"), "should find cleanup-old-posts job");
  });
});

describe("full discovery", () => {
  it("discovers all boundary nodes from fixture", async () => {
    const result = await discover(FIXTURE_PATH);
    assert.ok(result.nodes.length >= 10, `should find at least 10 nodes, found ${result.nodes.length}`);

    const kinds = {};
    for (const n of result.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;

    assert.ok(kinds.route >= 2, "should find routes");
    assert.ok(kinds.api_route >= 1, "should find API routes");
    assert.ok(kinds.server_action >= 2, "should find server actions");
    assert.ok(kinds.table >= 3, "should find tables");
    assert.ok(kinds.background_job >= 2, "should find background jobs");
    assert.ok(kinds.middleware >= 1, "should find middleware");
  });

  it("discovers edges from adapters", async () => {
    const result = await discover(FIXTURE_PATH);
    assert.ok(result.edges.length >= 1, `should find edges, found ${result.edges.length}`);
    const revalidateEdges = result.edges.filter((e) => e.edgeType === "revalidates");
    assert.ok(revalidateEdges.length >= 1, "should find revalidation edges");
  });

  it("returns valid workspace info", async () => {
    const result = await discover(FIXTURE_PATH);
    assert.ok(result.workspaces.length >= 1);
    assert.ok(result.repoRoot);
    assert.ok(result.stats.filesScanned >= 0);
    assert.ok(result.stats.nodesByKind);
  });
});
