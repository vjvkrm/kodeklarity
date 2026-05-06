import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Imports compiled output — npm test runs `npm run build` first.
const { startDashboard } = await import(path.join(__dirname, "..", "dist", "src", "dashboard", "server.js"));

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

describe("dashboard: server lifecycle and routes", () => {
  before(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "kk-dashboard-server-"));
    dashboard = await startDashboard({ cwd: workdir, port: 0 });
  });

  after(async () => {
    if (dashboard) await dashboard.close();
    if (workdir) await fs.rm(workdir, { recursive: true, force: true });
  });

  it("binds to 127.0.0.1 only (not 0.0.0.0)", async () => {
    const address = dashboard.server.address();
    assert.equal(address.address, "127.0.0.1", "Server must bind 127.0.0.1, not 0.0.0.0");
  });

  it("/api/status returns graphExists: false for a fresh cwd", async () => {
    const { status, body } = await fetchJson(`${dashboard.url}/api/status`);
    assert.equal(status, 200);
    assert.equal(body.graphExists, false);
    assert.equal(body.cwd, workdir);
    assert.equal(body.lastBuiltAt, null);
  });

  it("applies CSP and other security headers", async () => {
    const res = await fetch(`${dashboard.url}/api/status`);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  it("rejects unknown API routes with 404", async () => {
    const { status, body } = await fetchJson(`${dashboard.url}/api/does-not-exist`);
    assert.equal(status, 404);
    assert.match(body.error, /Unknown API route/);
  });

  it("rejects POST to read-only endpoints with 404 (route + method don't match)", async () => {
    const { status } = await fetchJson(`${dashboard.url}/api/status`, { method: "POST" });
    assert.equal(status, 404);
  });

  it("serves the SPA index.html as fallback for unknown SPA paths", async () => {
    const res = await fetch(`${dashboard.url}/some/spa/route`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /KodeKlarity Dashboard/);
  });

  it("rejects non-GET HTTP methods on static routes", async () => {
    const res = await fetch(`${dashboard.url}/`, { method: "DELETE" });
    assert.equal(res.status, 405);
  });
});

describe("dashboard: port discovery", () => {
  it("falls back to the next free port when the requested port is taken", async () => {
    // Pick a high random port to block, then ask the dashboard to start there.
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const blockedPort = blocker.address().port;

    let dash;
    try {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kk-port-"));
      dash = await startDashboard({ cwd: tmp, port: blockedPort });
      assert.notEqual(dash.port, blockedPort, "Should not bind the occupied port");
      assert.ok(dash.port > blockedPort, "Should pick a higher port");
    } finally {
      if (dash) await dash.close();
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe("dashboard: graceful shutdown", () => {
  it("close() resolves and frees the port", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kk-shutdown-"));
    const dash = await startDashboard({ cwd: tmp, port: 0 });
    const usedPort = dash.port;
    await dash.close();

    const free = await new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(usedPort, "127.0.0.1");
    });
    assert.equal(free, true, "Port must be free after close()");
  });
});
