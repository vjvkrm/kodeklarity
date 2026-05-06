import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9_:.\-/]+$/;

const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'";

export interface VerifyHostResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate the request Host header to mitigate DNS rebinding attacks.
 * Only `127.0.0.1:<port>` and `localhost:<port>` are accepted.
 */
export function verifyHost(req: IncomingMessage, expectedPort: number): VerifyHostResult {
  const host = req.headers.host;
  if (!host || typeof host !== "string") {
    return { ok: false, reason: "missing Host header" };
  }

  const colonIndex = host.lastIndexOf(":");
  if (colonIndex === -1) {
    return { ok: false, reason: "Host header missing port" };
  }

  const hostname = host.slice(0, colonIndex).toLowerCase();
  const portStr = host.slice(colonIndex + 1);
  const port = Number.parseInt(portStr, 10);

  if (!ALLOWED_HOSTS.has(hostname)) {
    return { ok: false, reason: `host ${hostname} not allowed` };
  }
  if (port !== expectedPort) {
    return { ok: false, reason: `port ${port} does not match server` };
  }
  return { ok: true };
}

/**
 * Reject path-param values that could traverse the filesystem or contain
 * control characters. Used for /api/node/:id and similar.
 */
export function sanitizeIdParam(value: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return null;
  }
  if (!SAFE_ID_PATTERN.test(value)) return null;
  if (value.includes("..")) return null;
  return value;
}

/** Apply standard security headers to every response. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP_HEADER);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}
