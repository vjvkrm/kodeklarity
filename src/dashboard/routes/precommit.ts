import type { ServerResponse } from "node:http";
import { sendJson, sendError } from "../security.js";

export async function handlePrecommitRoute(cwd: string, res: ServerResponse): Promise<void> {
  try {
    const { reviewGraph } = await import("../../review-graph.js");
    const result = await reviewGraph(cwd);
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, `Precommit query failed: ${message}`);
  }
}
