#!/usr/bin/env node

// When published, this file lives at dist/bin/kk.js and imports
// from dist/src/cli.js — the relative path ../src/cli.js resolves correctly
// in both the installed package layout and the local repo (since `npm run build`
// copies this file into dist/bin/).
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kk failed: ${message}`);
    process.exitCode = 1;
  });
