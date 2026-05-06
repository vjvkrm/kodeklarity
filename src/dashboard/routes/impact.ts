import type { ServerResponse } from "node:http";
import { sendJson, sendError } from "../security.js";
import { buildImpactGraph, buildPrecommitGraph } from "../impact-aggregator.js";

export async function handleImpactRoute(cwd: string, res: ServerResponse): Promise<void> {
  try {
    const result = await buildImpactGraph(cwd);
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, `Impact query failed: ${message}`);
  }
}

export async function handlePrecommitGraphRoute(cwd: string, res: ServerResponse): Promise<void> {
  try {
    const result = await buildPrecommitGraph(cwd);
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, `Precommit query failed: ${message}`);
  }
}
