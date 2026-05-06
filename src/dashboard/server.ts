import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySecurityHeaders, sanitizeIdParam, sendError, verifyHost } from "./security.js";
import { serveStatic } from "./static.js";
import { handleStatus } from "./routes/status.js";
import { handleBuild } from "./routes/build.js";
import { handlePrecommitGraphRoute, handleImpactRoute } from "./routes/impact.js";
import { handleNodeRoute } from "./routes/node.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4421;
const PORT_TRIES = 20;

export interface DashboardServerOptions {
  cwd: string;
  port?: number;
  webRoot?: string;
}

export interface RunningDashboard {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function findFreePort(start: number, host: string, maxTries: number): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const candidate = start + i;
    if (await isPortFree(candidate, host)) return candidate;
  }
  throw new Error(`No free port found in range ${start}..${start + maxTries - 1}`);
}

function defaultWebRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/dashboard/server.js → dist/dashboard/web
  return path.resolve(here, "../../dashboard/web");
}

function parseUrl(rawUrl: string | undefined): { pathname: string; query: URLSearchParams } {
  const safe = rawUrl ?? "/";
  const url = new URL(safe, "http://127.0.0.1");
  return { pathname: url.pathname, query: url.searchParams };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { cwd: string; webRoot: string; port: number },
): Promise<void> {
  applySecurityHeaders(res);

  const hostCheck = verifyHost(req, ctx.port);
  if (!hostCheck.ok) {
    sendError(res, 403, `Forbidden: ${hostCheck.reason}`);
    return;
  }

  const { pathname } = parseUrl(req.url);
  const method = req.method ?? "GET";

  // --- API routes ---
  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/status" && method === "GET") {
      return handleStatus(ctx.cwd, res);
    }
    if (pathname === "/api/build" && method === "POST") {
      return handleBuild(ctx.cwd, res);
    }
    if (pathname === "/api/precommit" && method === "GET") {
      return handlePrecommitGraphRoute(ctx.cwd, res);
    }
    if (pathname === "/api/impact" && method === "GET") {
      return handleImpactRoute(ctx.cwd, res);
    }
    if (pathname.startsWith("/api/node/") && method === "GET") {
      const raw = decodeURIComponent(pathname.slice("/api/node/".length));
      const id = sanitizeIdParam(raw);
      if (!id) {
        sendError(res, 400, "Invalid node id");
        return;
      }
      return handleNodeRoute(ctx.cwd, id, res);
    }
    sendError(res, 404, "Unknown API route");
    return;
  }

  // --- Static SPA ---
  if (method !== "GET" && method !== "HEAD") {
    sendError(res, 405, "Method not allowed");
    return;
  }
  await serveStatic(pathname, res, { rootDir: ctx.webRoot });
}

export async function startDashboard(opts: DashboardServerOptions): Promise<RunningDashboard> {
  const cwd = opts.cwd;
  const webRoot = opts.webRoot ?? defaultWebRoot();
  const requestedPort = opts.port;

  // port === 0 → let the OS assign a free port. Otherwise scan for one near the request.
  let bindPort: number;
  if (requestedPort === 0) {
    bindPort = 0;
  } else {
    bindPort = await findFreePort(requestedPort ?? DEFAULT_PORT, HOST, PORT_TRIES);
  }

  // Resolved by `listen` callback below. Captured by reference inside the request handler,
  // so by the time requests arrive, this holds the real port even when the OS assigned it.
  let actualPort = bindPort;

  const server = http.createServer((req, res) => {
    Promise.resolve(route(req, res, { cwd, webRoot, port: actualPort })).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        sendError(res, 500, `Server error: ${message}`);
      } catch {
        // response may already be ended
      }
    });
  });

  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    server.once("error", onError);
    server.listen(bindPort, HOST, () => {
      server.removeListener("error", onError);
      const addr = server.address();
      if (addr && typeof addr === "object") {
        actualPort = addr.port;
      }
      resolve();
    });
  });

  const url = `http://${HOST}:${actualPort}`;

  const close = async () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return { server, port: actualPort, url, close };
}
