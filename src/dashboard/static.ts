import type { ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { applySecurityHeaders } from "./security.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface StaticOptions {
  rootDir: string;
}

/**
 * Serve the built SPA. Falls back to index.html for unknown routes (SPA-style).
 * Rejects any path that escapes the configured root.
 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  opts: StaticOptions,
): Promise<void> {
  const root = path.resolve(opts.rootDir);

  let safePath = pathname;
  if (safePath === "/" || safePath === "") safePath = "/index.html";

  const candidate = path.resolve(root, "." + safePath);
  if (!candidate.startsWith(root + path.sep) && candidate !== root) {
    applySecurityHeaders(res);
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  let resolved: string | null = null;
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) resolved = candidate;
  } catch {
    resolved = null;
  }

  // SPA fallback: serve index.html for client-side routes.
  if (!resolved) {
    const indexPath = path.join(root, "index.html");
    try {
      await fs.access(indexPath);
      resolved = indexPath;
    } catch {
      applySecurityHeaders(res);
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";

  applySecurityHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);

  // Vite emits `name-HASH.{js,css}` for hashed assets; treat them as immutable.
  const isHashed = /[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(resolved);
  res.setHeader("Cache-Control", isHashed ? "public, max-age=31536000, immutable" : "no-cache");

  const data = await fs.readFile(resolved);
  res.end(data);
}
