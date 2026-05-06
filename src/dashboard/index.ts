import { startDashboard } from "./server.js";

interface DashboardArgs {
  port?: number;
  noOpen: boolean;
}

function parseDashboardArgs(args: string[]): DashboardArgs {
  let port: number | undefined;
  let noOpen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      const n = Number.parseInt(args[++i], 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
      continue;
    }
    if (a === "--no-open") {
      noOpen = true;
      continue;
    }
  }
  return { port, noOpen };
}

async function openInBrowser(url: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? `open "${url}"` :
    platform === "win32" ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  return new Promise<void>((resolve) => {
    exec(cmd, () => resolve());
  });
}

export async function handleDashboard(args: string[]): Promise<number> {
  const { port, noOpen } = parseDashboardArgs(args);

  const cwd = process.cwd();
  let dashboard;
  try {
    dashboard = await startDashboard({ cwd, port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start dashboard: ${message}`);
    return 1;
  }

  console.log("");
  console.log(`  KodeKlarity dashboard running at ${dashboard.url}`);
  console.log(`  cwd:    ${cwd}`);
  console.log(`  Press Ctrl+C to stop.`);
  console.log("");

  if (!noOpen) {
    void openInBrowser(dashboard.url);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${signal} received, shutting down...`);
    await dashboard.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the event loop alive forever (server already does this, but be explicit).
  return await new Promise<number>(() => {});
}
