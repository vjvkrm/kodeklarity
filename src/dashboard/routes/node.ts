import type { ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import { sendJson, sendError } from "../security.js";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";
const GLOBAL_FEATURE = "__global__";

export interface NodeDetails {
  node_id: string;
  symbol: string;
  kind: string;
  file: string;
  line: number;
  changed: boolean;
  diff: string | null;
  source: string | null;
}

function gitStatus(cwd: string, file: string): string | null {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", file], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.length > 0 ? out.slice(0, 2) : null;
  } catch {
    return null;
  }
}

function getFileDiff(cwd: string, file: string): string | null {
  // Tracked & modified: git diff HEAD shows working-tree vs HEAD (includes staged changes).
  try {
    const out = execFileSync("git", ["diff", "HEAD", "--", file], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    if (out.trim().length > 0) return out;
  } catch {
    // file may be untracked or git unavailable
  }

  // Untracked file: synthesize a "new file" unified diff so the UI can render it
  // with the same +/- coloring as a normal diff.
  const status = gitStatus(cwd, file);
  if (status && status.startsWith("??")) {
    try {
      const fullPath = path.resolve(cwd, file);
      const content = fsSync.readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/);
      // Drop a single trailing empty line caused by the final newline.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const header =
        `diff --git a/${file} b/${file}\n` +
        `new file mode 100644\n` +
        `--- /dev/null\n` +
        `+++ b/${file}\n` +
        `@@ -0,0 +1,${lines.length} @@\n`;
      const body = lines.map((l) => `+${l}`).join("\n");
      return header + body + (body.length > 0 ? "\n" : "");
    } catch {
      return null;
    }
  }

  return null;
}

async function readSnippet(cwd: string, file: string, line: number): Promise<string | null> {
  try {
    const fullPath = path.join(cwd, file);
    const data = await fs.readFile(fullPath, "utf8");
    const lines = data.split(/\r?\n/);
    const start = Math.max(0, line - 6);
    const end = Math.min(lines.length, line + 14);
    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
}

export async function handleNodeRoute(
  cwd: string,
  nodeId: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const dbPath = path.join(cwd, DEFAULT_DB_PATH);
    const db = (await import("../../db.js")) as unknown as {
      initGraphDb: (p: string) => Promise<void>;
      openDatabase: (p: string) => any;
      runMigrations: (db: any) => void;
    };
    await db.initGraphDb(dbPath);
    const conn = db.openDatabase(dbPath);
    let row:
      | { node_id: string; symbol: string; kind: string; file: string; line: number }
      | undefined;
    try {
      db.runMigrations(conn);
      row = conn
        .prepare(
          `SELECT node_id, symbol, kind, file, line FROM nodes WHERE feature_name = ? AND node_id = ? LIMIT 1`,
        )
        .get(GLOBAL_FEATURE, nodeId) as typeof row;
    } finally {
      conn.close();
    }

    if (!row) {
      sendJson(res, 404, { error: "Node not found", node_id: nodeId });
      return;
    }

    const diff = getFileDiff(cwd, row.file);
    const source = await readSnippet(cwd, row.file, row.line);

    const body: NodeDetails = {
      node_id: row.node_id,
      symbol: row.symbol,
      kind: row.kind,
      file: row.file,
      line: row.line,
      changed: diff !== null,
      diff,
      source,
    };
    sendJson(res, 200, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, `Node lookup failed: ${message}`);
  }
}
