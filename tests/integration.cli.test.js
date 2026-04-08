import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const REPO_ROOT = path.resolve(TEST_DIR, "..");
const CLI_BIN = path.resolve(REPO_ROOT, "bin", "kk-codeslice.js");
const EXAMPLE_PAYLOAD = path.resolve(REPO_ROOT, "examples", "authentication.payload.json");
const EXAMPLE_SEED_PAYLOAD = path.resolve(REPO_ROOT, "examples", "authentication.seed.payload.json");
const PROFILE_SEED_PAYLOAD = path.resolve(REPO_ROOT, "examples", "profile.seed.payload.json");
const CATALOG_SEED_PAYLOAD = path.resolve(REPO_ROOT, "examples", "catalog.seed.payload.json");
const INVENTORY_SEED_PAYLOAD = path.resolve(REPO_ROOT, "examples", "inventory.seed.payload.json");
const CHECKOUT_MONOREPO_SEED_PAYLOAD = path.resolve(REPO_ROOT, "examples", "checkout-monorepo.seed.payload.json");

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
  });

  return {
    code: result.status === null ? 1 : result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function parseJsonOutput(stdoutValue) {
  assert.ok(stdoutValue, "expected JSON output on stdout");
  try {
    return JSON.parse(stdoutValue);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    assert.fail(`stdout is not valid JSON: ${details}\n${stdoutValue}`);
  }
}

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("artifact create writes normalized request artifact", async () => {
  const tempDir = await createTempDir("kk-codeslice-artifact-");
  const outDir = path.join(tempDir, "requests");

  const result = runCli([
    "artifact",
    "create",
    "--mode",
    "full",
    "--request",
    EXAMPLE_PAYLOAD,
    "--out-dir",
    outDir,
    "--json",
  ]);

  assert.equal(result.code, 0, `unexpected exit code: ${result.stderr}`);

  const payload = parseJsonOutput(result.stdout);
  assert.equal(payload.status, "ok");
  assert.equal(payload.feature, "authentication");
  assert.equal(payload.intake_mode, "full");
  assert.equal(typeof payload.output_path, "string");

  const stat = await fs.stat(payload.output_path);
  assert.equal(stat.isFile(), true);
});

test("graph verify returns success and structured AST failure", async () => {
  const okResult = runCli(["graph", "verify", "--request", EXAMPLE_PAYLOAD, "--json"]);
  assert.equal(okResult.code, 0, `unexpected verify success code: ${okResult.stderr}`);

  const okPayload = parseJsonOutput(okResult.stdout);
  assert.equal(okPayload.status, "ok");
  assert.equal(okPayload.feature, "authentication");
  assert.equal(okPayload.checked_claims, 4);
  assert.equal(okPayload.issue_summary.total, 0);
  assert.equal(typeof okPayload.verification_confidence.confidence_score, "number");
  assert.equal(typeof okPayload.verification_confidence.confidence_label, "string");

  const tempDir = await createTempDir("kk-codeslice-verify-");
  const invalidPayloadPath = path.join(tempDir, "authentication.invalid.payload.json");
  const originalPayload = JSON.parse(await fs.readFile(EXAMPLE_PAYLOAD, "utf8"));
  originalPayload.entrypoints[0].symbol = "onSubmitTypoIntegration";
  await fs.writeFile(invalidPayloadPath, `${JSON.stringify(originalPayload, null, 2)}\n`, "utf8");

  const errorResult = runCli(["graph", "verify", "--request", invalidPayloadPath, "--json"]);
  assert.equal(errorResult.code, 2, `unexpected verify error code: ${errorResult.stderr}`);

  const errorPayload = parseJsonOutput(errorResult.stdout);
  assert.equal(errorPayload.status, "error");
  assert.equal(errorPayload.error_code, "AST_VERIFICATION_FAILED");
  assert.ok(Array.isArray(errorPayload.issues));
  assert.ok(errorPayload.issues.length >= 1);
  assert.equal(errorPayload.issue_summary.by_code.symbol_not_found >= 1, true);
});

test("graph lifecycle: build, rebuild, impact, upstream, downstream, side-effects, risk, why", async () => {
  const tempDir = await createTempDir("kk-codeslice-graph-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const buildResult = runCli(["graph", "build", "--request", EXAMPLE_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected build code: ${buildResult.stderr}`);
  const buildPayload = parseJsonOutput(buildResult.stdout);
  assert.equal(buildPayload.status, "ok");
  assert.equal(buildPayload.feature, "authentication");
  assert.equal(buildPayload.counts.nodes >= 1, true);
  assert.equal(buildPayload.counts.edges >= 1, true);
  assert.equal(typeof buildPayload.verification.verification_confidence.confidence_score, "number");
  assert.equal(typeof buildPayload.ast_expansion.expanded_origins, "number");
  assert.equal(typeof buildPayload.confidence_gate.confidence_score, "number");
  assert.equal(typeof buildPayload.confidence_gate.gate_status, "string");

  const rebuildResult = runCli([
    "graph",
    "rebuild",
    "--request",
    EXAMPLE_PAYLOAD,
    "--db-path",
    dbPath,
    "--changed-files",
    "src/features/auth/LoginForm.ts",
    "--json",
  ]);
  assert.equal(rebuildResult.code, 0, `unexpected rebuild code: ${rebuildResult.stderr}`);
  const rebuildPayload = parseJsonOutput(rebuildResult.stdout);
  assert.equal(rebuildPayload.status, "ok");
  assert.equal(rebuildPayload.matched_feature_files.length >= 1, true);
  assert.equal(rebuildPayload.strategy, "incremental_hunk_patch");
  assert.equal(typeof rebuildPayload.patch_stats.scoped_existing_edges, "number");
  assert.equal(typeof rebuildPayload.patch_stats.resulting_nodes, "number");

  const impactResult = runCli([
    "graph",
    "query",
    "impact",
    "--feature",
    "authentication",
    "--symbol",
    "onSubmit",
    "--depth",
    "4",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(impactResult.code, 0, `unexpected impact code: ${impactResult.stderr}`);
  const impactPayload = parseJsonOutput(impactResult.stdout);
  assert.equal(impactPayload.status, "ok");
  assert.equal(impactPayload.impact_count >= 1, true);
  assert.equal(typeof impactPayload.impacts[0].confidence_score, "number");
  assert.equal(typeof impactPayload.impacts[0].confidence_label, "string");

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "authentication",
    "--symbol",
    "onSubmit",
    "--depth",
    "4",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstream_count >= 1, true);
  assert.equal(downstreamPayload.downstream_count, downstreamPayload.impact_count);

  const upstreamResult = runCli([
    "graph",
    "query",
    "upstream",
    "--feature",
    "authentication",
    "--symbol",
    "authenticate",
    "--depth",
    "4",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(upstreamResult.code, 0, `unexpected upstream code: ${upstreamResult.stderr}`);
  const upstreamPayload = parseJsonOutput(upstreamResult.stdout);
  assert.equal(upstreamPayload.status, "ok");
  assert.equal(upstreamPayload.upstream_count >= 1, true);

  const sideEffectsResult = runCli([
    "graph",
    "query",
    "side-effects",
    "--feature",
    "authentication",
    "--symbol",
    "onSubmit",
    "--depth",
    "6",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(sideEffectsResult.code, 0, `unexpected side-effects code: ${sideEffectsResult.stderr}`);
  const sideEffectsPayload = parseJsonOutput(sideEffectsResult.stdout);
  assert.equal(sideEffectsPayload.status, "ok");
  assert.equal(sideEffectsPayload.side_effect_count >= 1, true);
  assert.equal(sideEffectsPayload.side_effects[0].side_effect_kind, "db_read");
  assert.equal(typeof sideEffectsPayload.side_effects[0].confidence_score, "number");

  const riskResult = runCli([
    "graph",
    "query",
    "risk",
    "--request",
    EXAMPLE_PAYLOAD,
    "--changed-files",
    "src/features/auth/LoginForm.ts",
    "--depth",
    "6",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(riskResult.code, 0, `unexpected risk code: ${riskResult.stderr}`);
  const riskPayload = parseJsonOutput(riskResult.stdout);
  assert.equal(riskPayload.status, "ok");
  assert.equal(riskPayload.rebuild_recommended, true);
  assert.equal(riskPayload.side_effect_count >= 1, true);
  assert.equal(["medium", "high"].includes(riskPayload.risk_level), true);
  assert.equal(typeof riskPayload.risk_factors.file_overlap_ratio.weight, "number");
  assert.equal(typeof riskPayload.risk_factors.side_effect_reach_ratio.value, "number");

  const whyResult = runCli([
    "graph",
    "query",
    "why",
    "--feature",
    "authentication",
    "--from",
    "onSubmit",
    "--to",
    "service.auth.authenticate",
    "--depth",
    "6",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(whyResult.code, 0, `unexpected why code: ${whyResult.stderr}`);
  const whyPayload = parseJsonOutput(whyResult.stdout);
  assert.equal(whyPayload.status, "ok");
  assert.equal(whyPayload.path_found, true);
  assert.equal(whyPayload.path_depth >= 1, true);
  assert.equal(typeof whyPayload.steps[0].confidence_score, "number");

  const diffResult = runCli([
    "graph",
    "query",
    "diff",
    "--feature",
    "authentication",
    "--build-a",
    buildPayload.build_id,
    "--build-b",
    rebuildPayload.build_id,
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(diffResult.code, 0, `unexpected diff code: ${diffResult.stderr}`);
  const diffPayload = parseJsonOutput(diffResult.stdout);
  assert.equal(diffPayload.status, "ok");
  assert.equal(diffPayload.build_a.build_id, buildPayload.build_id);
  assert.equal(diffPayload.build_b.build_id, rebuildPayload.build_id);
  assert.equal(typeof diffPayload.node_diff.added_count, "number");
  assert.equal(typeof diffPayload.edge_diff.changed_count, "number");
});

test("risk query missing --request returns INVALID_ARGUMENT contract", () => {
  const result = runCli(["graph", "query", "risk", "--json"]);
  assert.equal(result.code, 1, `unexpected missing request code: ${result.stderr}`);
  const payload = parseJsonOutput(result.stdout);
  assert.equal(payload.status, "error");
  assert.equal(payload.error_code, "INVALID_ARGUMENT");
});

test("seed graph build infers ast_calls edges from origins", async () => {
  const tempDir = await createTempDir("kk-codeslice-seed-ast-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const buildResult = runCli(["graph", "build", "--request", EXAMPLE_SEED_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected seed build code: ${buildResult.stderr}`);
  const buildPayload = parseJsonOutput(buildResult.stdout);
  assert.equal(buildPayload.status, "ok");
  assert.equal(buildPayload.ast_expansion.inferred_edges_added >= 1, true);

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "authentication",
    "--symbol",
    "onSubmit",
    "--depth",
    "3",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected seed downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstream_count >= 1, true);
  assert.equal(downstreamPayload.downstreams.some((row) => row.edge_type === "ast_calls"), true);
});

test("impact and downstream queries dedupe converging paths", async () => {
  const tempDir = await createTempDir("kk-codeslice-diamond-");
  const dbPath = path.join(tempDir, "graph.sqlite");
  const appRoot = path.join(tempDir, "diamond-app");
  const sourceDir = path.join(appRoot, "src");
  const sourcePath = path.join(sourceDir, "diamond.ts");
  const payloadPath = path.join(tempDir, "diamond.payload.json");

  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    sourcePath,
    [
      "export function start(): void {",
      "  left();",
      "  right();",
      "}",
      "",
      "export function left(): void {",
      "  shared();",
      "}",
      "",
      "export function right(): void {",
      "  shared();",
      "}",
      "",
      "export function shared(): void {",
      "  persist();",
      "}",
      "",
      "export function persist(): void {}",
      "",
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    payloadPath,
    `${JSON.stringify(
      {
        feature_name: "diamond-flow",
        repository_root: appRoot,
        notes: "Manual diamond graph used to verify traversal dedupe.",
        entrypoints: [
          {
            id: "entry.start",
            kind: "frontend_event",
            file: "src/diamond.ts",
            symbol: "start",
            line: 1,
            reason: "Feature starts from start().",
          },
        ],
        service_edges: [
          {
            from: "entry.start",
            to: "service.left",
            file: "src/diamond.ts",
            symbol: "start",
            line: 2,
            reason: "start calls left",
          },
          {
            from: "entry.start",
            to: "service.right",
            file: "src/diamond.ts",
            symbol: "start",
            line: 3,
            reason: "start calls right",
          },
          {
            from: "service.left",
            to: "service.shared",
            file: "src/diamond.ts",
            symbol: "left",
            line: 7,
            reason: "left calls shared",
          },
          {
            from: "service.right",
            to: "service.shared",
            file: "src/diamond.ts",
            symbol: "right",
            line: 11,
            reason: "right calls shared",
          },
          {
            from: "service.shared",
            to: "service.persist",
            file: "src/diamond.ts",
            symbol: "shared",
            line: 15,
            reason: "shared calls persist",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const buildResult = runCli(["graph", "build", "--request", payloadPath, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected diamond build code: ${buildResult.stderr}`);

  const impactResult = runCli([
    "graph",
    "query",
    "impact",
    "--feature",
    "diamond-flow",
    "--symbol",
    "start",
    "--depth",
    "4",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(impactResult.code, 0, `unexpected diamond impact code: ${impactResult.stderr}`);
  const impactPayload = parseJsonOutput(impactResult.stdout);
  assert.equal(impactPayload.status, "ok");
  assert.equal(impactPayload.impact_count, 5);
  assert.equal(
    impactPayload.impacts.filter(
      (row) => row.from_node_id === "service.shared" && row.to_node_id === "service.persist"
    ).length,
    1
  );

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "diamond-flow",
    "--symbol",
    "start",
    "--depth",
    "4",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected diamond downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstream_count, 5);
});

test("graph export and profile commands return machine-readable contracts", async () => {
  const tempDir = await createTempDir("kk-codeslice-export-profile-");
  const dbPath = path.join(tempDir, "graph.sqlite");
  const exportPath = path.join(tempDir, "snapshots", "auth.snapshot.json");

  const buildResult = runCli(["graph", "build", "--request", EXAMPLE_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected build code before export: ${buildResult.stderr}`);

  const exportResult = runCli([
    "graph",
    "export",
    "--feature",
    "authentication",
    "--db-path",
    dbPath,
    "--out",
    exportPath,
    "--json",
  ]);
  assert.equal(exportResult.code, 0, `unexpected export code: ${exportResult.stderr}`);
  const exportPayload = parseJsonOutput(exportResult.stdout);
  assert.equal(exportPayload.status, "ok");
  assert.equal(exportPayload.format_version, "kk-codeslice.snapshot.v1");
  assert.equal(typeof exportPayload.build.build_id, "string");
  const snapshotStat = await fs.stat(exportPayload.output_path);
  assert.equal(snapshotStat.isFile(), true);

  const profileResult = runCli([
    "graph",
    "profile",
    "--request",
    EXAMPLE_PAYLOAD,
    "--db-path",
    dbPath,
    "--changed-files",
    "src/features/auth/LoginForm.ts",
    "--json",
  ]);
  assert.equal(profileResult.code, 0, `unexpected profile code: ${profileResult.stderr}`);
  const profilePayload = parseJsonOutput(profileResult.stdout);
  assert.equal(profilePayload.status, "ok");
  assert.equal(typeof profilePayload.profile.stages.verify.duration_ms, "number");
  assert.equal(typeof profilePayload.profile.stages.build.duration_ms, "number");
  assert.equal(typeof profilePayload.profile.stages.risk.duration_ms, "number");
  assert.equal(typeof profilePayload.risk.risk_level, "string");
  assert.equal(typeof profilePayload.build.confidence_gate.gate_status, "string");
});

test("type-aware AST expansion resolves class receiver method chains", async () => {
  const tempDir = await createTempDir("kk-codeslice-type-aware-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const buildResult = runCli(["graph", "build", "--request", PROFILE_SEED_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected type-aware build code: ${buildResult.stderr}`);
  const buildPayload = parseJsonOutput(buildResult.stdout);
  assert.equal(buildPayload.status, "ok");
  assert.equal(buildPayload.ast_expansion.inferred_edges_added >= 2, true);

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "profile",
    "--symbol",
    "profileController",
    "--depth",
    "4",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected type-aware downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "loadProfile"), true);
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "fetchProfile"), true);
});

test("barrel re-export traversal resolves alias imports to implementation symbols", async () => {
  const tempDir = await createTempDir("kk-codeslice-barrel-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const buildResult = runCli(["graph", "build", "--request", CATALOG_SEED_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected barrel build code: ${buildResult.stderr}`);
  const buildPayload = parseJsonOutput(buildResult.stdout);
  assert.equal(buildPayload.status, "ok");
  assert.equal(buildPayload.ast_expansion.inferred_edges_added >= 2, true);

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "catalog",
    "--symbol",
    "catalogEntry",
    "--depth",
    "5",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected barrel downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "loadItem"), true);
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "fetchItem"), true);
});

test("tsconfig alias-path resolution traverses non-relative imports in AST expansion", async () => {
  const tempDir = await createTempDir("kk-codeslice-alias-paths-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const buildResult = runCli(["graph", "build", "--request", INVENTORY_SEED_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(buildResult.code, 0, `unexpected alias-path build code: ${buildResult.stderr}`);
  const buildPayload = parseJsonOutput(buildResult.stdout);
  assert.equal(buildPayload.status, "ok");
  assert.equal(buildPayload.ast_expansion.inferred_edges_added >= 2, true);

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "inventory",
    "--symbol",
    "inventoryEntry",
    "--depth",
    "5",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected alias-path downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "getInventory"), true);
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "loadFromStore"), true);
});

test("monorepo tsconfig references + extends resolve alias chains for AST expansion", async () => {
  const tempDir = await createTempDir("kk-codeslice-monorepo-alias-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const buildResult = runCli([
    "graph",
    "build",
    "--request",
    CHECKOUT_MONOREPO_SEED_PAYLOAD,
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(buildResult.code, 0, `unexpected monorepo alias build code: ${buildResult.stderr}`);
  const buildPayload = parseJsonOutput(buildResult.stdout);
  assert.equal(buildPayload.status, "ok");
  assert.equal(buildPayload.ast_expansion.inferred_edges_added >= 2, true);

  const downstreamResult = runCli([
    "graph",
    "query",
    "downstream",
    "--feature",
    "checkout_monorepo",
    "--symbol",
    "checkoutEntry",
    "--depth",
    "5",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(downstreamResult.code, 0, `unexpected monorepo alias downstream code: ${downstreamResult.stderr}`);
  const downstreamPayload = parseJsonOutput(downstreamResult.stdout);
  assert.equal(downstreamPayload.status, "ok");
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "getQuote"), true);
  assert.equal(downstreamPayload.downstreams.some((edge) => edge.to_symbol === "computeQuote"), true);

  const exportResult = runCli([
    "graph",
    "export",
    "--feature",
    "checkout_monorepo",
    "--db-path",
    dbPath,
    "--json",
  ]);
  assert.equal(exportResult.code, 0, `unexpected monorepo export code: ${exportResult.stderr}`);
  const exportPayload = parseJsonOutput(exportResult.stdout);
  assert.equal(exportPayload.status, "ok");

  const aliasEdge = exportPayload.edges.find(
    (edge) =>
      edge.edge_type === "ast_calls" &&
      edge.metadata &&
      edge.metadata.resolved_module_specifier === "@mono-shared/price/price.service"
  );
  assert.ok(aliasEdge, "expected ast_calls edge with monorepo alias module specifier");
  assert.equal(typeof aliasEdge.metadata.resolved_by_tsconfig, "string");
  assert.equal(aliasEdge.metadata.resolved_by_tsconfig.includes("packages/app/tsconfig.json"), true);
  assert.equal(typeof aliasEdge.metadata.resolver_scope, "string");
  assert.equal(aliasEdge.metadata.resolver_scope.includes("monorepo-app/tsconfig.json"), true);
});

test("graph export supports historical --build-id snapshots", async () => {
  const tempDir = await createTempDir("kk-codeslice-export-history-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const fullBuild = runCli(["graph", "build", "--request", EXAMPLE_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(fullBuild.code, 0, `unexpected full build code: ${fullBuild.stderr}`);
  const fullPayload = parseJsonOutput(fullBuild.stdout);

  const seedBuild = runCli(["graph", "build", "--request", EXAMPLE_SEED_PAYLOAD, "--db-path", dbPath, "--json"]);
  assert.equal(seedBuild.code, 0, `unexpected seed build code: ${seedBuild.stderr}`);
  const seedPayload = parseJsonOutput(seedBuild.stdout);
  assert.notEqual(fullPayload.build_id, seedPayload.build_id);

  const historicalExport = runCli([
    "graph",
    "export",
    "--feature",
    "authentication",
    "--db-path",
    dbPath,
    "--build-id",
    fullPayload.build_id,
    "--json",
  ]);
  assert.equal(historicalExport.code, 0, `unexpected historical export code: ${historicalExport.stderr}`);
  const historicalPayload = parseJsonOutput(historicalExport.stdout);
  assert.equal(historicalPayload.status, "ok");
  assert.equal(historicalPayload.build.build_id, fullPayload.build_id);
  assert.equal(historicalPayload.counts.nodes, fullPayload.counts.nodes);
  assert.equal(historicalPayload.counts.edges, fullPayload.counts.edges);
});

test("graph build enforce-confidence can block low-confidence inferred graphs", async () => {
  const tempDir = await createTempDir("kk-codeslice-confidence-gate-");
  const dbPath = path.join(tempDir, "graph.sqlite");

  const result = runCli([
    "graph",
    "build",
    "--request",
    EXAMPLE_SEED_PAYLOAD,
    "--db-path",
    dbPath,
    "--min-confidence",
    "95",
    "--enforce-confidence",
    "--json",
  ]);

  assert.equal(result.code, 2, `unexpected enforce-confidence code: ${result.stderr}`);
  const payload = parseJsonOutput(result.stdout);
  assert.equal(payload.status, "error");
  assert.equal(payload.error_code, "CONFIDENCE_GATE_FAILED");
  assert.equal(typeof payload.confidence_gate.confidence_score, "number");
  assert.equal(payload.confidence_gate.gate_status, "fail");
});
