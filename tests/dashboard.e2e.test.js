import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_FIXTURE = path.join(__dirname, "fixtures", "nextjs-drizzle-app");
const KK_BIN = path.join(__dirname, "..", "dist", "bin", "kk.js");

const { startDashboard } = await import(
  path.join(__dirname, "..", "dist", "src", "dashboard", "server.js")
);

let workdir;
let dashboard;

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

describe("dashboard: end-to-end against fixture repo", () => {
  before(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "kk-dashboard-e2e-"));
    // Copy fixture to a tmp dir so we don't pollute the source.
    execSync(`cp -R "${SOURCE_FIXTURE}/." "${workdir}/"`);
    // Initialize as a git repo so reviewGraph has something to diff against.
    execSync("git init -q", { cwd: workdir });
    execSync("git -c user.email=t@t -c user.name=T add -A", { cwd: workdir });
    execSync("git -c user.email=t@t -c user.name=T commit -q -m initial", { cwd: workdir });
    // Build the kk graph for the fixture.
    execSync(`node ${KK_BIN} init --force`, { cwd: workdir, stdio: ["ignore", "ignore", "ignore"] });

    dashboard = await startDashboard({ cwd: workdir, port: 0 });
  });

  after(async () => {
    if (dashboard) await dashboard.close();
    if (workdir) await fs.rm(workdir, { recursive: true, force: true });
  });

  it("/api/status reports graphExists: true after build", async () => {
    const { status, body } = await fetchJson(`${dashboard.url}/api/status`);
    assert.equal(status, 200);
    assert.equal(body.graphExists, true);
    assert.ok(body.lastBuiltAt);
  });

  it("/api/precommit returns a clean tree response when no changes", async () => {
    const { status, body } = await fetchJson(`${dashboard.url}/api/precommit`);
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(Array.isArray(body.nodes), true);
    assert.equal(Array.isArray(body.edges), true);
    assert.equal(body.nodes.length, 0); // no diff yet
  });

  it("/api/impact returns a clean tree response when no changes", async () => {
    const { status, body } = await fetchJson(`${dashboard.url}/api/impact`);
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.nodes.length, 0);
  });

  it("/api/precommit reflects an actual edit to a tracked file", async () => {
    // Modify a file in the fixture and verify precommit picks it up.
    const target = path.join(workdir, "src", "actions", "users.ts");
    let original = "";
    try {
      original = await fs.readFile(target, "utf8");
    } catch {
      // fixture may use different paths; try a more general approach
    }
    if (!original) {
      // find any .ts file we can edit
      const candidates = execSync(
        `find . -name '*.ts' -not -path './node_modules/*' -not -path './.kodeklarity/*' | head -1`,
        { cwd: workdir, encoding: "utf8" },
      ).trim();
      if (!candidates) return;
      const edit = path.join(workdir, candidates);
      const text = await fs.readFile(edit, "utf8");
      await fs.writeFile(edit, text + "\n// e2e dashboard edit\n");
    } else {
      await fs.writeFile(target, original + "\n// e2e dashboard edit\n");
    }

    const { status, body } = await fetchJson(`${dashboard.url}/api/precommit`);
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.ok(body.changedFiles.length >= 1, "Expected at least one changed file");
  });

  it("serves the SPA at / with the right title", async () => {
    const res = await fetch(dashboard.url);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /KodeKlarity Dashboard/);
    assert.match(text, /<div id="root">/);
  });

  it("serves SPA assets with the immutable cache-control header", async () => {
    // Find an asset URL by parsing index.html.
    const html = await (await fetch(dashboard.url)).text();
    const match = html.match(/\/assets\/[A-Za-z0-9.\-_]+\.js/);
    assert.ok(match, "Expected an asset URL in index.html");
    const res = await fetch(`${dashboard.url}${match[0]}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  });
});
