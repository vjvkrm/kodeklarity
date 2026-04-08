#!/usr/bin/env node

// Try dist first (compiled TS), fall back to src (pure JS legacy commands)
let runCli;
try {
  const mod = await import("../dist/src/cli.js");
  runCli = mod.runCli;
} catch {
  const mod = await import("../src/cli.js");
  runCli = mod.runCli;
}

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kk failed: ${message}`);
    process.exitCode = 1;
  });
