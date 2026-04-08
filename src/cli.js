import fs from "node:fs/promises";
import path from "node:path";
import { buildTemplatePayload, readPayloadInput, writeNormalizedRequest } from "./intake.js";
import {
  buildGraphFromRequestFile,
  exportGraphSnapshot,
  initGraphDb,
  profileGraphWorkflow,
  queryBuildDiff,
  queryDownstream,
  queryImpact,
  queryRisk,
  querySideEffects,
  queryUpstream,
  queryWhy,
  rebuildGraphFromDiff,
  resolveDbPath,
  verifyGraphRequestFile,
} from "./graph.js";
import { INTAKE_MODES, normalizeAndValidatePayload } from "./validate-request.js";
import { handleInit } from "./init.js";
import { handleImpact, handleUpstream, handleDownstream, handleSideEffects, handleWhy, handleRisk, handleStatus } from "./commands.js";
import { handleRebuild } from "./rebuild.js";

const HELP_TEXT = `kk — KodeKlarity code graph for AI agents

Usage:
  kk init [--force] [--json]              Build the code graph (full scan)
  kk rebuild [--force] [--json] [--quiet] Incremental rebuild from git diff
  kk impact <symbol> [--depth N] [--json]  What breaks if I change this?
  kk upstream <symbol> [--depth N] [--json] What depends on this?
  kk downstream <symbol> [--depth N] [--json] What does this call?
  kk side-effects <symbol> [--depth N] [--json] What side effects does this trigger?
  kk why --from <symbol> --to <symbol> [--json] How are these connected?
  kk risk [--json]                         Risk score for current git changes
  kk status [--json]                       Show graph overview

Legacy commands:
  kk artifact create --request <path|-> [--mode <auto|full|seed>] [--out-dir <path>] [--json]
  kk artifact template [--feature <name>] [--mode <full|seed>]

  kk graph init [--db-path <path>] [--json]
  kk-codeslice graph verify --request <path> [--json]
  kk-codeslice graph build --request <path> [--keep-builds <n>] [--min-confidence <1-100>] [--enforce-confidence] [--db-path <path>] [--json]
  kk-codeslice graph rebuild --request <path> [--changed-files <csv>] [--base-ref <ref>] [--head-ref <ref>] [--keep-builds <n>] [--db-path <path>] [--json]
  kk-codeslice graph export --feature <name> [--build-id <id>] [--out <path>] [--db-path <path>] [--json]
  kk-codeslice graph profile --request <path> [--changed-files <csv>] [--base-ref <ref>] [--head-ref <ref>] [--depth <n>] [--keep-builds <n>] [--db-path <path>] [--json]

  kk-codeslice graph query impact --feature <name> --symbol <symbol> [--depth <n>] [--db-path <path>] [--json]
  kk-codeslice graph query downstream --feature <name> --symbol <symbol> [--depth <n>] [--db-path <path>] [--json]
  kk-codeslice graph query upstream --feature <name> --symbol <symbol> [--depth <n>] [--db-path <path>] [--json]
  kk-codeslice graph query risk --request <path> [--changed-files <csv>] [--base-ref <ref>] [--head-ref <ref>] [--depth <n>] [--db-path <path>] [--json]
  kk-codeslice graph query side-effects --feature <name> --symbol <symbol> [--depth <n>] [--db-path <path>] [--json]
  kk-codeslice graph query why --feature <name> --from <node|symbol> --to <node|symbol> [--depth <n>] [--db-path <path>] [--json]
  kk-codeslice graph query diff --feature <name> --build-a <id> --build-b <id> [--db-path <path>] [--json]

  kk-codeslice help

Examples:
  kk-codeslice artifact create --mode seed --request ./examples/authentication.seed.payload.json --json
  kk-codeslice graph init
  kk-codeslice graph verify --request ./examples/authentication.payload.json --json
  kk-codeslice graph build --request ./examples/authentication.payload.json --keep-builds 20
  kk-codeslice graph rebuild --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts
  kk-codeslice graph query impact --feature authentication --symbol onSubmit --depth 4 --json
  kk-codeslice graph query downstream --feature authentication --symbol onSubmit --depth 4 --json
  kk-codeslice graph query upstream --feature authentication --symbol authenticate --depth 4 --json
  kk-codeslice graph query risk --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts --depth 6 --json
  kk-codeslice graph query side-effects --feature authentication --symbol onSubmit --depth 6 --json
  kk-codeslice graph query why --feature authentication --from onSubmit --to service.auth.authenticate --depth 5 --json
  kk-codeslice graph query diff --feature authentication --build-a <old-build-id> --build-b <new-build-id> --json
  kk-codeslice graph export --feature authentication --out ./artifacts/auth.snapshot.json --json
  kk-codeslice graph profile --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts --json
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

function isValidCreateMode(value) {
  return INTAKE_MODES.includes(value);
}

function isValidTemplateMode(value) {
  return value === "full" || value === "seed";
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

async function writeJsonFile(filePath, payload) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolutePath;
}

function emitUnknownFlagError(parsed, asJson, hint) {
  emitError(
    buildCliError("INVALID_ARGUMENT", "Unknown or incomplete CLI flags.", {
      issues: parsed.unknownFlags.map((flag) => ({
        path: "cli.flags",
        code: "unknown_flag",
        expected: "known flag",
        actual: flag,
        fix: hint,
      })),
      retryHint: "Run: kk-codeslice help",
    }),
    asJson
  );
}

function requireFlagString(parsed, flagName, asJson, exampleCommand) {
  const value = parsed.flags[flagName];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  emitError(
    buildCliError("INVALID_ARGUMENT", `Missing required flag: --${flagName}`, {
      issues: [
        {
          path: `cli.flags.${flagName}`,
          code: "required",
          expected: "non-empty string",
          actual: String(value),
          fix: `Provide --${flagName} <value>`,
        },
      ],
      retryHint: exampleCommand,
    }),
    asJson
  );

  return null;
}

async function handleArtifactCreate(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --request, --mode, --out-dir, or --json only.");
    return 1;
  }

  const requestArg = requireFlagString(
    parsed,
    "request",
    asJson,
    "Example: kk-codeslice artifact create --request ./examples/authentication.payload.json"
  );

  if (!requestArg) {
    return 1;
  }

  const modeRaw = typeof parsed.flags.mode === "string" ? parsed.flags.mode.trim().toLowerCase() : "auto";
  if (!isValidCreateMode(modeRaw)) {
    emitError(
      buildCliError("INVALID_ARGUMENT", `Unsupported mode '${modeRaw}'.`, {
        issues: [
          {
            path: "cli.flags.mode",
            code: "invalid_value",
            expected: "auto | full | seed",
            actual: modeRaw,
            fix: "Set --mode to auto, full, or seed.",
          },
        ],
        retryHint: "Example: kk-codeslice artifact create --mode seed --request ./payload.json",
      }),
      asJson
    );
    return 1;
  }

  let inputPayload;
  try {
    inputPayload = await readPayloadInput(requestArg, process.cwd());
  } catch (error) {
    emitError(
      buildCliError("PAYLOAD_PARSE_ERROR", "Unable to read/parse payload JSON.", {
        issues: [
          {
            path: "payload",
            code: "invalid_json",
            expected: "valid JSON object",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Fix JSON syntax and retry.",
          },
        ],
        retryHint: "Validate JSON, then rerun kk-codeslice artifact create.",
      }),
      asJson
    );
    return 2;
  }

  const validation = normalizeAndValidatePayload(inputPayload, process.cwd(), modeRaw);

  if (!validation.ok) {
    emitError(validation.error, asJson);
    return 2;
  }

  const outDir = typeof parsed.flags["out-dir"] === "string" ? parsed.flags["out-dir"] : undefined;
  const result = await writeNormalizedRequest(validation.value, {
    cwd: process.cwd(),
    outDir,
  });

  const summary = {
    status: "ok",
    request_id: result.requestId,
    output_path: result.outputPath,
    intake_mode: validation.value.intake_mode,
    feature: validation.value.feature.name,
    counts: result.counts,
  };

  emitSuccess(summary, asJson, (payload) => {
    console.log(`Created request artifact: ${payload.output_path}`);
    console.log(`Feature: ${payload.feature}`);
    console.log(`Mode: ${payload.intake_mode}`);
    console.log(
      `Counts: origins=${payload.counts.origins}, entrypoints=${payload.counts.entrypoints}, api_edges=${payload.counts.api_edges}, service_edges=${payload.counts.service_edges}, side_effects=${payload.counts.side_effects}`
    );
  });

  return 0;
}

async function handleArtifactTemplate(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --feature or --mode for template command.");
    return 1;
  }

  const modeRaw = typeof parsed.flags.mode === "string" ? parsed.flags.mode.trim().toLowerCase() : "full";
  const mode = modeRaw === "auto" ? "full" : modeRaw;

  if (!isValidTemplateMode(mode)) {
    emitError(
      buildCliError("INVALID_ARGUMENT", `Unsupported template mode '${modeRaw}'.`, {
        issues: [
          {
            path: "cli.flags.mode",
            code: "invalid_value",
            expected: "full | seed",
            actual: modeRaw,
            fix: "Set --mode to full or seed for template output.",
          },
        ],
        retryHint: "Example: kk-codeslice artifact template --mode seed --feature authentication",
      }),
      asJson
    );
    return 1;
  }

  const feature = typeof parsed.flags.feature === "string" ? parsed.flags.feature : "authentication";
  const template = buildTemplatePayload(feature, mode);

  console.log(JSON.stringify(template, null, 2));

  return 0;
}

async function handleGraphInit(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --db-path and --json only for graph init.");
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await initGraphDb(dbPath);
    emitSuccess(
      {
        status: "ok",
        db_path: result.dbPath,
        migration_count: result.migration_count,
      },
      asJson,
      (payload) => {
        console.log(`Initialized graph database: ${payload.db_path}`);
        console.log(`Migrations: ${payload.migration_count}`);
      }
    );
    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_INIT_FAILED", "Failed to initialize graph database.", {
        issues: [
          {
            path: "graph.init",
            code: "runtime_error",
            expected: "sqlite initialization success",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Verify sqlite library availability and db path permissions.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphVerify(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --request and --json only for graph verify.");
    return 1;
  }

  const requestPath = requireFlagString(
    parsed,
    "request",
    asJson,
    "Example: kk-codeslice graph verify --request ./examples/authentication.payload.json --json"
  );

  if (!requestPath) {
    return 1;
  }

  try {
    const result = await verifyGraphRequestFile({
      cwd: process.cwd(),
      requestPath,
    });

    if (result.status === "error") {
      emitError(result, asJson);
      return 2;
    }

    emitSuccess(result, asJson, (payload) => {
      console.log(`AST verification passed for feature '${payload.feature || "<unknown>"}'.`);
      console.log(`Request: ${payload.request_path}`);
      console.log(`Repository root: ${payload.repository_root}`);
      console.log(`Checked claims: ${payload.checked_claims}`);
    });

    return 0;
  } catch (error) {
    const structuredError = extractStructuredGraphError(error);
    if (structuredError) {
      emitError(structuredError, asJson);
      return 2;
    }

    emitError(
      buildCliError("GRAPH_VERIFY_FAILED", "Failed to verify request artifact evidence.", {
        issues: [
          {
            path: "graph.verify",
            code: "runtime_error",
            expected: "valid request artifact with parseable JSON",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Fix payload format/errors and rerun graph verify.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphBuild(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --request, --keep-builds, --min-confidence, --enforce-confidence, --db-path, and --json for graph build."
    );
    return 1;
  }

  const requestPath = requireFlagString(
    parsed,
    "request",
    asJson,
    "Example: kk-codeslice graph build --request ./.kodeklarity/requests/authentication/<file>.json"
  );

  if (!requestPath) {
    return 1;
  }

  const keepBuilds = parsePositiveInteger(parsed.flags["keep-builds"], 20);
  if (keepBuilds === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid keep-builds value.", {
        issues: [
          {
            path: "cli.flags.keep-builds",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags["keep-builds"]),
            fix: "Set --keep-builds to an integer >= 1 (example: --keep-builds 20).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const minConfidence = parseConfidenceScore(parsed.flags["min-confidence"], 60);
  if (minConfidence === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid min-confidence value.", {
        issues: [
          {
            path: "cli.flags.min-confidence",
            code: "invalid_value",
            expected: "integer between 1 and 100",
            actual: String(parsed.flags["min-confidence"]),
            fix: "Set --min-confidence to a value between 1 and 100 (example: --min-confidence 60).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const enforceConfidence = Boolean(parsed.flags["enforce-confidence"]);

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await buildGraphFromRequestFile({
      cwd: process.cwd(),
      dbPath,
      requestPath,
      keepBuilds,
      minConfidenceScore: minConfidence,
      enforceConfidenceGate: enforceConfidence,
    });

    emitSuccess(result, asJson, (payload) => {
      console.log(`Built graph snapshot: ${payload.build_id}`);
      console.log(`Feature: ${payload.feature}`);
      console.log(`Database: ${payload.db_path}`);
      console.log(`Request: ${payload.request_path}`);
      console.log(`Verification claims: ${payload.verification.checked_claims}`);
      console.log(`Counts: nodes=${payload.counts.nodes}, edges=${payload.counts.edges}`);
      console.log(
        `Confidence gate: ${payload.confidence_gate.gate_status} (${payload.confidence_gate.confidence_score}/${payload.confidence_gate.min_confidence_score})`
      );
      console.log(`Pruned builds: ${payload.pruned_builds}`);
    });

    return 0;
  } catch (error) {
    const structuredError = extractStructuredGraphError(error);
    if (structuredError) {
      emitError(structuredError, asJson);
      return 2;
    }

    emitError(
      buildCliError("GRAPH_BUILD_FAILED", "Failed to build graph from request artifact.", {
        issues: [
          {
            path: "graph.build",
            code: "runtime_error",
            expected: "valid request artifact, AST-valid evidence, writable database",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Fix payload evidence and rerun graph build.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphRebuild(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --request, --changed-files, --base-ref, --head-ref, --keep-builds, --db-path, and --json for graph rebuild."
    );
    return 1;
  }

  const requestPath = requireFlagString(
    parsed,
    "request",
    asJson,
    "Example: kk-codeslice graph rebuild --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts"
  );

  if (!requestPath) {
    return 1;
  }

  const keepBuilds = parsePositiveInteger(parsed.flags["keep-builds"], 20);
  if (keepBuilds === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid keep-builds value.", {
        issues: [
          {
            path: "cli.flags.keep-builds",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags["keep-builds"]),
            fix: "Set --keep-builds to an integer >= 1.",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const changedFiles = parseChangedFiles(parsed.flags["changed-files"]);
  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await rebuildGraphFromDiff({
      cwd: process.cwd(),
      dbPath,
      requestPath,
      changedFiles,
      baseRef: typeof parsed.flags["base-ref"] === "string" ? parsed.flags["base-ref"] : undefined,
      headRef: typeof parsed.flags["head-ref"] === "string" ? parsed.flags["head-ref"] : undefined,
      keepBuilds,
    });

    emitSuccess(result, asJson, (payload) => {
      if (payload.status === "skipped") {
        console.log(`Rebuild skipped (${payload.reason}).`);
        console.log(`Feature: ${payload.feature}`);
        console.log(`Changed files: ${payload.changed_files.length}`);
        return;
      }

      console.log(`Rebuild completed: ${payload.build_id}`);
      console.log(`Feature: ${payload.feature}`);
      console.log(`Strategy: ${payload.strategy}`);
      console.log(`Changed files: ${payload.changed_files.length}`);
      console.log(`Matched feature files: ${payload.matched_feature_files.length}`);
      console.log(`Pruned builds: ${payload.pruned_builds}`);
    });

    return 0;
  } catch (error) {
    const structuredError = extractStructuredGraphError(error);
    if (structuredError) {
      emitError(structuredError, asJson);
      return 2;
    }

    emitError(
      buildCliError("GRAPH_REBUILD_FAILED", "Failed to execute graph rebuild strategy.", {
        issues: [
          {
            path: "graph.rebuild",
            code: "runtime_error",
            expected: "valid request + git diff context or changed-files list",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Provide --changed-files explicitly or run from a git repository.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphExport(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --feature, --build-id, --out, --db-path, and --json for graph export.");
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph export --feature authentication --out ./artifacts/auth.snapshot.json"
  );

  if (!feature) {
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);
  const buildId = typeof parsed.flags["build-id"] === "string" ? parsed.flags["build-id"].trim() : undefined;
  const outPath = typeof parsed.flags.out === "string" ? parsed.flags.out.trim() : undefined;

  try {
    const result = await exportGraphSnapshot({
      dbPath,
      feature,
      buildId,
    });

    if (result.status === "error") {
      emitError(result, asJson);
      return 2;
    }

    const payload = { ...result };
    if (outPath) {
      payload.output_path = await writeJsonFile(outPath, result);
    }

    emitSuccess(payload, asJson, (value) => {
      console.log(`Exported graph snapshot for feature '${value.feature}'.`);
      console.log(`Build: ${value.build.build_id}`);
      console.log(`Format: ${value.format_version}`);
      console.log(`Counts: nodes=${value.counts.nodes}, edges=${value.counts.edges}`);
      if (value.output_path) {
        console.log(`Output: ${value.output_path}`);
      }
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_EXPORT_FAILED", "Failed to export graph snapshot.", {
        issues: [
          {
            path: "graph.export",
            code: "runtime_error",
            expected: "existing feature graph in sqlite",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Run graph build first, then retry graph export.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphProfile(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --request, --changed-files, --base-ref, --head-ref, --depth, --keep-builds, --db-path, and --json for graph profile."
    );
    return 1;
  }

  const requestPath = requireFlagString(
    parsed,
    "request",
    asJson,
    "Example: kk-codeslice graph profile --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts"
  );

  if (!requestPath) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 6);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1.",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const keepBuilds = parsePositiveInteger(parsed.flags["keep-builds"], 20);
  if (keepBuilds === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid keep-builds value.", {
        issues: [
          {
            path: "cli.flags.keep-builds",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags["keep-builds"]),
            fix: "Set --keep-builds to an integer >= 1.",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const changedFiles = parseChangedFiles(parsed.flags["changed-files"]);
  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await profileGraphWorkflow({
      cwd: process.cwd(),
      dbPath,
      requestPath,
      depth,
      keepBuilds,
      changedFiles,
      baseRef: typeof parsed.flags["base-ref"] === "string" ? parsed.flags["base-ref"] : undefined,
      headRef: typeof parsed.flags["head-ref"] === "string" ? parsed.flags["head-ref"] : undefined,
    });

    if (result.status === "error") {
      emitError(result, asJson);
      return 2;
    }

    emitSuccess(result, asJson, (payload) => {
      console.log(`Graph profile for feature '${payload.feature}'`);
      console.log(`Total: ${payload.profile.total.duration_ms}ms (target ${payload.profile.total.target_ms}ms)`);
      console.log(
        `Stages: verify=${payload.profile.stages.verify.duration_ms}ms, build=${payload.profile.stages.build.duration_ms}ms, risk=${payload.profile.stages.risk.duration_ms}ms`
      );
      console.log(`Within target: ${payload.profile.within_target ? "yes" : "no"}`);
      console.log(`Risk: ${payload.risk.risk_level} (${payload.risk.risk_score ?? "n/a"})`);
    });

    return 0;
  } catch (error) {
    const structuredError = extractStructuredGraphError(error);
    if (structuredError) {
      emitError(structuredError, asJson);
      return 2;
    }

    emitError(
      buildCliError("GRAPH_PROFILE_FAILED", "Failed to profile graph workflow.", {
        issues: [
          {
            path: "graph.profile",
            code: "runtime_error",
            expected: "valid request + writable db",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Fix request/db issues and retry graph profile.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQueryImpact(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --feature, --symbol, --depth, --db-path, and --json for impact queries.");
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph query impact --feature authentication --symbol onSubmit"
  );

  if (!feature) {
    return 1;
  }

  const symbol = requireFlagString(
    parsed,
    "symbol",
    asJson,
    "Example: kk-codeslice graph query impact --feature authentication --symbol onSubmit"
  );

  if (!symbol) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 4);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1 (example: --depth 4).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await queryImpact({
      dbPath,
      feature,
      symbol,
      depth,
    });

    emitSuccess(result, asJson, (payload) => {
      console.log(`Impact query for symbol '${payload.symbol}' in feature '${payload.feature}'`);
      console.log(`Database: ${payload.db_path}`);
      console.log(`Start nodes: ${payload.start_nodes.length}`);
      console.log(`Impacted edges: ${payload.impact_count}`);

      for (const edge of payload.impacts) {
        const toSymbol = edge.to_symbol || edge.to_node_id;
        console.log(
          `- depth=${edge.depth} ${edge.from_node_id} -> ${edge.to_node_id} [${edge.edge_type}] => ${toSymbol}`
        );
      }
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph impact query.", {
        issues: [
          {
            path: "graph.query.impact",
            code: "runtime_error",
            expected: "initialized db and queryable feature graph",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Run graph init + graph build before querying.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQueryDownstream(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --feature, --symbol, --depth, --db-path, and --json for downstream queries."
    );
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph query downstream --feature authentication --symbol onSubmit"
  );

  if (!feature) {
    return 1;
  }

  const symbol = requireFlagString(
    parsed,
    "symbol",
    asJson,
    "Example: kk-codeslice graph query downstream --feature authentication --symbol onSubmit"
  );

  if (!symbol) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 4);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1 (example: --depth 4).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await queryDownstream({
      dbPath,
      feature,
      symbol,
      depth,
    });

    emitSuccess(result, asJson, (payload) => {
      console.log(`Downstream query for symbol '${payload.symbol}' in feature '${payload.feature}'`);
      console.log(`Database: ${payload.db_path}`);
      console.log(`Start nodes: ${payload.start_nodes.length}`);
      console.log(`Downstream edges: ${payload.downstream_count}`);

      for (const edge of payload.downstreams) {
        const toSymbol = edge.to_symbol || edge.to_node_id;
        console.log(
          `- depth=${edge.depth} ${edge.from_node_id} -> ${edge.to_node_id} [${edge.edge_type}] => ${toSymbol}`
        );
      }
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph downstream query.", {
        issues: [
          {
            path: "graph.query.downstream",
            code: "runtime_error",
            expected: "initialized db and queryable feature graph",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Run graph init + graph build before querying.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQueryUpstream(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --feature, --symbol, --depth, --db-path, and --json for upstream queries.");
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph query upstream --feature authentication --symbol authenticate"
  );

  if (!feature) {
    return 1;
  }

  const symbol = requireFlagString(
    parsed,
    "symbol",
    asJson,
    "Example: kk-codeslice graph query upstream --feature authentication --symbol authenticate"
  );

  if (!symbol) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 4);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1 (example: --depth 4).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await queryUpstream({
      dbPath,
      feature,
      symbol,
      depth,
    });

    emitSuccess(result, asJson, (payload) => {
      console.log(`Upstream query for symbol '${payload.symbol}' in feature '${payload.feature}'`);
      console.log(`Database: ${payload.db_path}`);
      console.log(`Start nodes: ${payload.start_nodes.length}`);
      console.log(`Upstream edges: ${payload.upstream_count}`);

      for (const edge of payload.upstreams) {
        const fromSymbol = edge.from_symbol || edge.from_node_id;
        console.log(
          `- depth=${edge.depth} ${edge.from_node_id} -> ${edge.to_node_id} [${edge.edge_type}] <= ${fromSymbol}`
        );
      }
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph upstream query.", {
        issues: [
          {
            path: "graph.query.upstream",
            code: "runtime_error",
            expected: "initialized db and queryable feature graph",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Run graph init + graph build before querying.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQuerySideEffects(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --feature, --symbol, --depth, --db-path, and --json for side-effects queries."
    );
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph query side-effects --feature authentication --symbol onSubmit"
  );

  if (!feature) {
    return 1;
  }

  const symbol = requireFlagString(
    parsed,
    "symbol",
    asJson,
    "Example: kk-codeslice graph query side-effects --feature authentication --symbol onSubmit"
  );

  if (!symbol) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 6);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1 (example: --depth 6).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await querySideEffects({
      dbPath,
      feature,
      symbol,
      depth,
    });

    emitSuccess(result, asJson, (payload) => {
      console.log(`Side-effects query for symbol '${payload.symbol}' in feature '${payload.feature}'`);
      console.log(`Database: ${payload.db_path}`);
      console.log(`Start nodes: ${payload.start_nodes.length}`);
      console.log(`Reachable side effects: ${payload.side_effect_count}`);

      for (const sideEffect of payload.side_effects) {
        const kind = sideEffect.side_effect_kind || sideEffect.edge_type || "side_effect";
        const target = sideEffect.side_effect_target || sideEffect.to_node_id;
        console.log(
          `- depth=${sideEffect.depth} via ${sideEffect.from_node_id} -> ${sideEffect.to_node_id} [${kind}] target=${target}`
        );
      }
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph side-effects query.", {
        issues: [
          {
            path: "graph.query.side_effects",
            code: "runtime_error",
            expected: "initialized db and queryable feature graph",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Run graph init + graph build before querying.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQueryRisk(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --request, --changed-files, --base-ref, --head-ref, --depth, --db-path, and --json for risk queries."
    );
    return 1;
  }

  const requestPath = requireFlagString(
    parsed,
    "request",
    asJson,
    "Example: kk-codeslice graph query risk --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts"
  );

  if (!requestPath) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 6);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1 (example: --depth 6).",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const changedFiles = parseChangedFiles(parsed.flags["changed-files"]);
  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await queryRisk({
      cwd: process.cwd(),
      dbPath,
      requestPath,
      changedFiles,
      baseRef: typeof parsed.flags["base-ref"] === "string" ? parsed.flags["base-ref"] : undefined,
      headRef: typeof parsed.flags["head-ref"] === "string" ? parsed.flags["head-ref"] : undefined,
      depth,
    });

    emitSuccess(result, asJson, (payload) => {
      console.log(`Risk query for feature '${payload.feature}'`);
      console.log(`Risk level: ${payload.risk_level} (${payload.risk_score ?? "n/a"})`);
      console.log(`Reason: ${payload.risk_reason}`);
      console.log(`Changed files: ${payload.changed_files.length}`);
      console.log(`Matched feature files: ${payload.matched_feature_files.length}`);
      console.log(`Impacted nodes: ${payload.impacted_node_count}`);
      console.log(`Reachable side effects: ${payload.side_effect_count}`);
    });

    return 0;
  } catch (error) {
    const structuredError = extractStructuredGraphError(error);
    if (structuredError) {
      emitError(structuredError, asJson);
      return 2;
    }

    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph risk query.", {
        issues: [
          {
            path: "graph.query.risk",
            code: "runtime_error",
            expected: "valid request + changed-files list or git diff context",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Provide --changed-files explicitly or run from a git repository.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQueryWhy(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(parsed, asJson, "Use --feature, --from, --to, --depth, --db-path, and --json for why queries.");
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph query why --feature authentication --from onSubmit --to service.auth.authenticate"
  );

  if (!feature) {
    return 1;
  }

  const from = requireFlagString(
    parsed,
    "from",
    asJson,
    "Example: kk-codeslice graph query why --feature authentication --from onSubmit --to service.auth.authenticate"
  );

  if (!from) {
    return 1;
  }

  const to = requireFlagString(
    parsed,
    "to",
    asJson,
    "Example: kk-codeslice graph query why --feature authentication --from onSubmit --to service.auth.authenticate"
  );

  if (!to) {
    return 1;
  }

  const depth = parsePositiveInteger(parsed.flags.depth, 6);
  if (depth === null) {
    emitError(
      buildCliError("INVALID_ARGUMENT", "Invalid depth value.", {
        issues: [
          {
            path: "cli.flags.depth",
            code: "invalid_value",
            expected: "positive integer",
            actual: String(parsed.flags.depth),
            fix: "Set --depth to an integer >= 1.",
          },
        ],
      }),
      asJson
    );
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await queryWhy({
      dbPath,
      feature,
      from,
      to,
      depth,
    });

    if (result.status === "error") {
      emitError(result, asJson);
      return 2;
    }

    emitSuccess(result, asJson, (payload) => {
      if (!payload.path_found) {
        console.log(`No path found from '${payload.from}' to '${payload.to}' within depth ${payload.max_depth}.`);
        return;
      }

      console.log(`Why path in feature '${payload.feature}'`);
      console.log(`From: ${payload.resolved_from_node.node_id}`);
      console.log(`To: ${payload.resolved_to_node.node_id}`);
      console.log(`Depth: ${payload.path_depth}`);

      for (const step of payload.steps) {
        console.log(
          `- step=${step.step} ${step.from_node_id} -> ${step.to_node_id} [${step.edge_type}] @ ${step.file}:${step.line}`
        );
      }
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph why query.", {
        issues: [
          {
            path: "graph.query.why",
            code: "runtime_error",
            expected: "initialized db and queryable feature graph",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Run graph init + graph build before querying.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQueryDiff(args) {
  const parsed = parseArgs(args);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.unknownFlags.length > 0) {
    emitUnknownFlagError(
      parsed,
      asJson,
      "Use --feature, --build-a, --build-b, --db-path, and --json for diff queries."
    );
    return 1;
  }

  const feature = requireFlagString(
    parsed,
    "feature",
    asJson,
    "Example: kk-codeslice graph query diff --feature authentication --build-a <id> --build-b <id>"
  );
  if (!feature) {
    return 1;
  }

  const buildA = requireFlagString(
    parsed,
    "build-a",
    asJson,
    "Example: kk-codeslice graph query diff --feature authentication --build-a <id> --build-b <id>"
  );
  if (!buildA) {
    return 1;
  }

  const buildB = requireFlagString(
    parsed,
    "build-b",
    asJson,
    "Example: kk-codeslice graph query diff --feature authentication --build-a <id> --build-b <id>"
  );
  if (!buildB) {
    return 1;
  }

  const dbPath = resolveDbPath(process.cwd(), parsed.flags["db-path"]);

  try {
    const result = await queryBuildDiff({
      dbPath,
      feature,
      buildA,
      buildB,
    });

    if (result.status === "error") {
      emitError(result, asJson);
      return 2;
    }

    emitSuccess(result, asJson, (payload) => {
      console.log(`Graph diff for feature '${payload.feature}'`);
      console.log(`Build A: ${payload.build_a.build_id}`);
      console.log(`Build B: ${payload.build_b.build_id}`);
      console.log(
        `Nodes: +${payload.node_diff.added_count} -${payload.node_diff.removed_count} ~${payload.node_diff.changed_count}`
      );
      console.log(
        `Edges: +${payload.edge_diff.added_count} -${payload.edge_diff.removed_count} ~${payload.edge_diff.changed_count}`
      );
    });

    return 0;
  } catch (error) {
    emitError(
      buildCliError("GRAPH_QUERY_FAILED", "Failed to execute graph diff query.", {
        issues: [
          {
            path: "graph.query.diff",
            code: "runtime_error",
            expected: "existing builds for feature",
            actual: error instanceof Error ? error.message : String(error),
            fix: "Create at least two builds for the feature and retry.",
          },
        ],
      }),
      asJson
    );
    return 2;
  }
}

async function handleGraphQuery(args) {
  const [queryType, ...rest] = args;

  if (queryType === "impact") {
    return handleGraphQueryImpact(rest);
  }

  if (queryType === "downstream") {
    return handleGraphQueryDownstream(rest);
  }

  if (queryType === "upstream") {
    return handleGraphQueryUpstream(rest);
  }

  if (queryType === "risk") {
    return handleGraphQueryRisk(rest);
  }

  if (queryType === "side-effects") {
    return handleGraphQuerySideEffects(rest);
  }

  if (queryType === "why") {
    return handleGraphQueryWhy(rest);
  }

  if (queryType === "diff") {
    return handleGraphQueryDiff(rest);
  }

  console.error(`Unknown graph query type: ${queryType || "<missing>"}`);
  console.log(HELP_TEXT);
  return 1;
}

async function handleGraphCommand(subcommand, rest) {
  if (subcommand === "init") {
    return handleGraphInit(rest);
  }

  if (subcommand === "verify") {
    return handleGraphVerify(rest);
  }

  if (subcommand === "build") {
    return handleGraphBuild(rest);
  }

  if (subcommand === "rebuild") {
    return handleGraphRebuild(rest);
  }

  if (subcommand === "export") {
    return handleGraphExport(rest);
  }

  if (subcommand === "profile") {
    return handleGraphProfile(rest);
  }

  if (subcommand === "query") {
    return handleGraphQuery(rest);
  }

  console.error(`Unknown graph subcommand: ${subcommand || "<missing>"}`);
  console.log(HELP_TEXT);
  return 1;
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
  if (command === "status") return handleStatus([subcommand, ...rest].filter(Boolean));

  if (command === "artifact") {
    if (subcommand === "create") {
      return handleArtifactCreate(rest);
    }

    if (subcommand === "template") {
      return handleArtifactTemplate(rest);
    }

    console.error(`Unknown artifact subcommand: ${subcommand || "<missing>"}`);
    console.log(HELP_TEXT);
    return 1;
  }

  if (command === "graph") {
    return handleGraphCommand(subcommand, rest);
  }

  console.error(`Unknown command: ${command}`);
  console.log(HELP_TEXT);
  return 1;
}
