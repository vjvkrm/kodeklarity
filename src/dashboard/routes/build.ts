import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, sendError } from "../security.js";

interface BuildState {
  inflight: Promise<BuildResult> | null;
}

const state: BuildState = { inflight: null };

export interface BuildResult {
  status: "ok" | "error";
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** Resolve the absolute path to the kk CLI bin (the same one the user invoked). */
function resolveKkBin(): string {
  // dist/src/dashboard/routes/build.js → dist/bin/kk.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../bin/kk.js");
}

async function runBuild(cwd: string): Promise<BuildResult> {
  const start = Date.now();
  const kkBin = resolveKkBin();

  return await new Promise<BuildResult>((resolve) => {
    const child = spawn(process.execPath, [kkBin, "init", "--force", "--json"], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      resolve({
        status: "error",
        exitCode: -1,
        durationMs: Date.now() - start,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
      });
    });

    child.on("exit", (code) => {
      const exitCode = code ?? -1;
      resolve({
        status: exitCode === 0 ? "ok" : "error",
        exitCode,
        durationMs: Date.now() - start,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Build the graph. Single-flight: concurrent calls share one underlying build.
 */
export async function handleBuild(cwd: string, res: ServerResponse): Promise<void> {
  try {
    if (!state.inflight) {
      state.inflight = runBuild(cwd).finally(() => {
        state.inflight = null;
      });
    }
    const result = await state.inflight;
    sendJson(res, result.status === "ok" ? 200 : 500, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, `Build failed: ${message}`);
  }
}

/** For tests. */
export function _resetBuildState(): void {
  state.inflight = null;
}
