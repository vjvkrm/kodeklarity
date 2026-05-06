import type { ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { sendJson } from "../security.js";

const DEFAULT_DB_PATH = ".kodeklarity/index/graph.sqlite";

export interface StatusResponse {
  graphExists: boolean;
  dbPath: string;
  lastBuiltAt: string | null;
  cwd: string;
}

export async function handleStatus(cwd: string, res: ServerResponse): Promise<void> {
  const dbPath = path.join(cwd, DEFAULT_DB_PATH);

  let graphExists = false;
  let lastBuiltAt: string | null = null;

  try {
    const stat = await fs.stat(dbPath);
    if (stat.isFile()) {
      graphExists = true;
      lastBuiltAt = stat.mtime.toISOString();
    }
  } catch {
    graphExists = false;
  }

  const body: StatusResponse = {
    graphExists,
    dbPath,
    lastBuiltAt,
    cwd,
  };

  sendJson(res, 200, body);
}
