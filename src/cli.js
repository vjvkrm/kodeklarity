import { handleInit } from "./init.js";
import { handleImpact, handleUpstream, handleDownstream, handleSideEffects, handleWhy, handleRisk, handleStatus, handleSearch } from "./commands.js";
import { handleRebuild } from "./rebuild.js";

const HELP_TEXT = `kk — KodeKlarity code graph for AI agents

Usage:
  kk init [--force] [--json]                Build the code graph (full scan)
  kk rebuild [--force] [--json] [--quiet]   Incremental rebuild from git diff
  kk impact <symbol> [--depth N] [--json]   What breaks if I change this?
  kk upstream <symbol> [--depth N] [--json]  What depends on this?
  kk downstream <symbol> [--depth N] [--json] What does this call?
  kk side-effects <symbol> [--depth N] [--json] What side effects does this trigger?
  kk why --from <symbol> --to <symbol> [--json] How are these connected?
  kk risk [--json]                           Risk score for current git changes
  kk search <term> [--json]                   Find nodes by name
  kk status [--json]                         Show graph overview
  kk help                                    Show this help

Examples:
  kk init
  kk impact updateUser --depth 3
  kk upstream requireAuth --depth 2
  kk side-effects createContract --depth 4
  kk why --from createContract --to users
  kk risk
  kk status --json
`;

const VALUE_FLAGS = new Set([
  "request",
  "out-dir",
  "feature",
  "mode",
  "db-path",
  "symbol",
  "depth",
  "from",
  "to",
  "base-ref",
  "head-ref",
  "changed-files",
  "keep-builds",
  "build-id",
  "out",
  "min-confidence",
  "build-a",
  "build-b",
]);
const BOOLEAN_FLAGS = new Set(["json", "enforce-confidence"]);

function parseArgs(args) {
  const positional = [];
  const flags = {};
  const unknownFlags = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    const key = rawKey.trim();

    if (!key) {
      unknownFlags.push(token);
      continue;
    }

    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = inlineValue === undefined ? true : inlineValue === "true";
      continue;
    }

    if (VALUE_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }

      const nextToken = args[index + 1];
      if (!nextToken || nextToken.startsWith("--")) {
        unknownFlags.push(`--${key}`);
        continue;
      }

      flags[key] = nextToken;
      index += 1;
      continue;
    }

    unknownFlags.push(`--${key}`);
  }

  return {
    positional,
    flags,
    unknownFlags,
  };
}

function buildCliError(errorCode, message, options = {}) {
  return {
    status: "error",
    error_code: errorCode,
    message,
    issues: options.issues ?? [],
    retry_hint: options.retryHint,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractStructuredGraphError(error) {
  if (!(error instanceof Error) || typeof error.code !== "string" || !error.code.trim()) {
    return null;
  }

  const details = isObject(error.details) ? error.details : {};
  const message = typeof error.message === "string" && error.message.trim() ? error.message : "Graph operation failed.";

  return {
    ...details,
    status: "error",
    error_code: error.code,
    message,
  };
}

function printHumanError(errorPayload) {
  console.error(errorPayload.message);

  const issues = Array.isArray(errorPayload.issues) ? errorPayload.issues : [];
  if (issues.length > 0) {
    console.error("Issues:");
    for (const issue of issues) {
      const pathValue = issue.path || "$";
      const code = issue.code || "invalid";
      const expected = issue.expected ? ` expected=${issue.expected};` : "";
      const actual = issue.actual ? ` actual=${issue.actual};` : "";
      const fix = issue.fix ? ` fix=${issue.fix}` : "";
      console.error(`- [${code}] ${pathValue};${expected}${actual}${fix}`);
    }
  }

  if (errorPayload.retry_hint) {
    console.error(`Retry hint: ${errorPayload.retry_hint}`);
  }
}

function emitError(errorPayload, asJson) {
  if (asJson) {
    console.log(JSON.stringify(errorPayload, null, 2));
    return;
  }

  printHumanError(errorPayload);
}

function emitSuccess(payload, asJson, printer) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printer(payload);
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function parseConfidenceScore(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    return null;
  }

  return parsed;
}

function parseChangedFiles(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function runCli(argv) {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP_TEXT);
    return 0;
  }

  if (command === "init") {
    return handleInit([subcommand, ...rest].filter(Boolean));
  }

  if (command === "rebuild") {
    return handleRebuild([subcommand, ...rest].filter(Boolean));
  }

  // Simplified top-level commands
  if (command === "impact") return handleImpact([subcommand, ...rest].filter(Boolean));
  if (command === "upstream") return handleUpstream([subcommand, ...rest].filter(Boolean));
  if (command === "downstream") return handleDownstream([subcommand, ...rest].filter(Boolean));
  if (command === "side-effects") return handleSideEffects([subcommand, ...rest].filter(Boolean));
  if (command === "why") return handleWhy([subcommand, ...rest].filter(Boolean));
  if (command === "risk") return handleRisk([subcommand, ...rest].filter(Boolean));
  if (command === "search") return handleSearch([subcommand, ...rest].filter(Boolean));
  if (command === "status") return handleStatus([subcommand, ...rest].filter(Boolean));

  console.error(`Unknown command: ${command}`);
  console.log(HELP_TEXT);
  return 1;
}
