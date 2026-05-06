import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { startDashboard } = await import(path.join(__dirname, "..", "dist", "src", "dashboard", "server.js"));
const { sanitizeIdParam, verifyHost } = await import(path.join(__dirname, "..", "dist", "src", "dashboard", "security.js"));

// fetch (undici) strips the Host header. Use raw http for tests that need to forge it.
function rawGet({ port, pathname, hostHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let workdir;
let dashboard;

describe("dashboard: security middleware (live server)", () => {
  before(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "kk-dashboard-sec-"));
    dashboard = await startDashboard({ cwd: workdir, port: 0 });
  });

  after(async () => {
    if (dashboard) await dashboard.close();
    if (workdir) await fs.rm(workdir, { recursive: true, force: true });
  });

  it("rejects requests with a non-localhost Host header (DNS rebinding defense)", async () => {
    const res = await rawGet({
      port: dashboard.port,
      pathname: "/api/status",
      hostHeader: `evil.com:${dashboard.port}`,
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
  });

  it("rejects requests with the wrong port in Host", async () => {
    const wrongPort = dashboard.port === 1 ? 2 : dashboard.port + 1;
    const res = await rawGet({
      port: dashboard.port,
      pathname: "/api/status",
      hostHeader: `127.0.0.1:${wrongPort}`,
    });
    assert.equal(res.status, 403);
  });

  it("rejects /api/node/<traversal> with 400", async () => {
    // ".." in path is normalized by the URL parser; encode it so it survives.
    const res = await fetch(`${dashboard.url}/api/node/${encodeURIComponent("../../etc/passwd")}`);
    assert.equal(res.status, 400);
  });

  it("rejects /api/node/<unsafe-chars> with 400", async () => {
    const res = await fetch(`${dashboard.url}/api/node/${encodeURIComponent("a; rm -rf /")}`);
    assert.equal(res.status, 400);
  });

  it("returns 404 (not 400) for a syntactically valid but unknown node id", async () => {
    const res = await fetch(`${dashboard.url}/api/node/some_valid-id.123`);
    assert.equal(res.status, 404);
  });

  it("static handler refuses to serve files outside web root", async () => {
    // Even with encoded traversal, the static handler must not escape rootDir.
    const res = await fetch(`${dashboard.url}/${encodeURIComponent("../../package.json")}`);
    // SPA fallback returns 200 for unmatched routes; what matters is we don't
    // leak package.json content.
    const text = await res.text();
    assert.doesNotMatch(text, /"name":\s*"kodeklarity"/);
  });
});

describe("dashboard: security unit tests", () => {
  it("sanitizeIdParam accepts safe ids", () => {
    assert.equal(sanitizeIdParam("simple_id-123"), "simple_id-123");
    assert.equal(sanitizeIdParam("a:b/c.d"), "a:b/c.d");
  });

  it("sanitizeIdParam rejects traversal", () => {
    assert.equal(sanitizeIdParam("../etc/passwd"), null);
    assert.equal(sanitizeIdParam("a/../b"), null);
  });

  it("sanitizeIdParam rejects shell-y characters", () => {
    assert.equal(sanitizeIdParam("a; ls"), null);
    assert.equal(sanitizeIdParam("a|b"), null);
    assert.equal(sanitizeIdParam("a$b"), null);
    assert.equal(sanitizeIdParam("a`b"), null);
  });

  it("sanitizeIdParam rejects empty and absurdly long inputs", () => {
    assert.equal(sanitizeIdParam(""), null);
    assert.equal(sanitizeIdParam("a".repeat(257)), null);
  });

  it("verifyHost accepts 127.0.0.1 and localhost", () => {
    assert.equal(verifyHost({ headers: { host: "127.0.0.1:4421" } }, 4421).ok, true);
    assert.equal(verifyHost({ headers: { host: "localhost:4421" } }, 4421).ok, true);
    assert.equal(verifyHost({ headers: { host: "LOCALHOST:4421" } }, 4421).ok, true);
  });

  it("verifyHost rejects mismatched ports", () => {
    assert.equal(verifyHost({ headers: { host: "127.0.0.1:9999" } }, 4421).ok, false);
  });

  it("verifyHost rejects unknown hostnames", () => {
    assert.equal(verifyHost({ headers: { host: "evil.com:4421" } }, 4421).ok, false);
    assert.equal(verifyHost({ headers: { host: "0.0.0.0:4421" } }, 4421).ok, false);
  });

  it("verifyHost rejects missing or malformed Host headers", () => {
    assert.equal(verifyHost({ headers: {} }, 4421).ok, false);
    assert.equal(verifyHost({ headers: { host: "no-port" } }, 4421).ok, false);
  });
});
