# KodeKlarity Slice Graph

`KodeKlarity Slice Graph` is a TypeScript-first project to build feature artifacts that AI coding agents can query with high accuracy and low token usage.

## Core Idea

Instead of sending broad file context to an LLM, we build a structured, evidence-backed feature graph:

- Slice a feature vertically by execution flow.
- Capture relationships across frontend, API, DTOs, backend services, and side effects.
- Store these as queryable graph artifacts.
- Let developers and AI agents retrieve only the relevant feature context.

## Problem We Want to Solve

AI agents in large codebases often fail due to context overload and weak feature boundaries.

This project aims to improve:

- Accuracy of generated code and reasoning.
- Change-impact understanding.
- Token efficiency for agent context.
- Confidence through evidence-backed relationships.

## What a Feature Boundary Means (v0)

A feature slice follows execution path:

1. Frontend entry point (UI route/action/component event)
2. API endpoint invoked
3. DTO/schema mapping
4. Backend service/domain handling
5. Side effects (DB read/write, event publish, external API)

Shared utilities are linked as dependencies but not always owned by the feature.

## v0 Scope

- Language: TypeScript only.
- Stack: start with one practical frontend + backend pattern.
- Feature selection: developer picks a feature before querying.
- Update model: incremental updates from git diff before active work.
- Trust model: every relation stores source evidence (file, symbol, line, commit).

## Proposed System Components

- **Ingestion**: parse code + build execution-aligned feature slices.
- **Request Intake CLI (`kk-codeslice`)**: accept LLM payloads, validate structure, and persist normalized artifact requests.
- **Boundary Extractor**: produce boundary candidates from static signals + optional LLM inference.
- **Graph Builder**: create typed nodes and edges for feature artifacts.
- **Snapshot Engine**: keep commit-aware versions and stale detection.
- **Query API**: return compact evidence packs for selected feature.
- **Agent Adapter**: make artifacts easy to consume from Codex/LLMs.

## Primary Use Case: Feature-First Engineering

This project is intentionally feature-first, because that is how engineers usually work:

- Build a new feature end-to-end.
- Modify an existing feature safely.
- Check if a change can break related flows or hidden side effects.

With a feature map, Claude Code (or similar agents) can answer impact questions using direct function/method relationships and traced execution edges, instead of relying on grep hits or similarity search guesses.

Example questions the agent should answer reliably:

- "If I change this method, what else will change in this feature slice?"
- "Which side effects are touched by this login flow change?"
- "What downstream API/service paths are at risk before I ship?"

## Why This Is Different

This is not generic repo RAG.

It is execution-grounded, feature-scoped memory designed for software agents:

- Smaller context
- Better relevance
- Traceable reasoning
- Safer code changes

## Step 1 (Implemented): LLM Payload Intake + Verified Graph Baseline

Before full CPG and automatic AST traversal, we standardize intake and build a verified feature graph baseline from payload evidence.

Flow:

1. Agent (Codex/Claude/Cursor) gathers feature boundary candidates from repo context.
2. Agent chooses intake mode:
   - `full`: provide explicit boundary sets.
   - `seed`: provide only where feature originates, then let graph build expand later.
3. Agent writes structured JSON payload.
   - Full mode fields:
   - `feature_name`
   - `repository_root`
   - `entrypoints[]`
   - `api_edges[]`
   - `service_edges[]`
   - `side_effects[]`
   - each item must include evidence fields (`file`, `line`, `reason`) and symbol where relevant
   - Seed mode fields:
   - `feature_name`
   - `repository_root`
   - `origins[]` (each origin must include `file`, `symbol`, `line`, `reason`)
4. Agent runs:
   - `kk-codeslice artifact create --mode <full|seed|auto> --request <payload.json>`
5. CLI validates payload shape and evidence completeness.
6. If payload is invalid, CLI returns structured JSON errors (`path`, `code`, `expected`, `actual`, `fix`) so agent can self-correct and retry.
7. CLI persists normalized request artifact in `.kodeklarity/requests/<feature>/...`.
8. Agent runs `kk-codeslice graph verify` to validate AST evidence before writing graph state.
9. Agent runs `kk-codeslice graph build` to persist typed nodes/edges in SQLite.
10. Graph build performs origin-based AST expansion MVP (`ast_calls`) when origins are provided, including `tsconfig` alias-path imports and monorepo alias chaining through `references` + `extends`.
11. Agent runs `kk-codeslice graph query impact|upstream|downstream|side-effects|risk|why` for feature-scoped impact and path explanations.
12. Query responses include confidence labels/scores and weighted risk factors.
13. AST inferred edges include resolver diagnostics (`resolved_module_specifier`, `resolved_by_tsconfig`, `resolver_scope`) for alias-debug visibility.
14. Agent can export snapshots and run profiling baselines for performance tracking.
15. Agent runs `kk-codeslice graph rebuild` to patch graph scope incrementally from git diff hunks when overlap exists.

Current boundary: we have payload-driven graph build with AST verification, import-aware origin expansion, class receiver type-hint method resolution, barrel/re-export chain traversal, and `tsconfig` alias-path support for non-relative imports (including monorepo `references` + `extends` alias chaining), but not full CPG and not full polymorphic/type-checker-backed resolution yet.

## SQLite Graph Storage (v0)

Graph data is stored locally in SQLite:

- DB path (default): `.kodeklarity/index/graph.sqlite`
- Request artifacts (input): `.kodeklarity/requests/<feature>/...`
- SQLite runtime: bundled via npm dependency (`better-sqlite3`) so users do not need system `sqlite3` CLI installed.

The graph is represented as typed `nodes` + `edges` tables with evidence fields (`file`, `line`, `reason`) and feature scoping.
Graph writes are protected by an AST verification gate: every evidence claim must reference a real file, valid line, and existing symbol before build succeeds.
Build snapshots are persisted per build in `build_nodes` + `build_edges` so exports can target historical retained builds (`--build-id`).

### Commands

```bash
# Initialize graph database schema
kk-codeslice graph init

# Verify request artifact evidence without writing graph state
kk-codeslice graph verify --request ./examples/authentication.payload.json --json

# Build graph from normalized request artifact
kk-codeslice graph build --request ./.kodeklarity/requests/authentication/<request-file>.json

# Keep only latest N build snapshots per feature
kk-codeslice graph build --request ./examples/authentication.payload.json --keep-builds 20

# Enforce confidence gate for inferred graphs
kk-codeslice graph build --request ./examples/authentication.seed.payload.json --min-confidence 95 --enforce-confidence --json

# Build graph directly from raw payload (CLI will normalize first)
kk-codeslice graph build --request ./examples/authentication.payload.json

# Build graph from a seed payload that relies on tsconfig alias imports (@server/*)
kk-codeslice graph build --request ./examples/inventory.seed.payload.json --json

# Build graph from a monorepo seed payload where alias mappings come through tsconfig references + extends
kk-codeslice graph build --request ./examples/checkout-monorepo.seed.payload.json --json

# Query change impact for a symbol within a feature slice
kk-codeslice graph query impact --feature authentication --symbol onSubmit --depth 4 --json

# Query upstream callers/dependencies for a symbol
kk-codeslice graph query upstream --feature authentication --symbol authenticate --depth 4 --json

# Query downstream propagation path for a symbol
kk-codeslice graph query downstream --feature authentication --symbol onSubmit --depth 4 --json

# Query reachable side effects from a symbol within a feature slice
kk-codeslice graph query side-effects --feature authentication --symbol onSubmit --depth 6 --json

# Query change risk from changed files against the feature graph
kk-codeslice graph query risk --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts --depth 6 --json

# Explain relationship path between two nodes/symbols
kk-codeslice graph query why --feature authentication --from onSubmit --to service.auth.authenticate --depth 6 --json

# Diff two builds for feature graph changes
kk-codeslice graph query diff --feature authentication --build-a <old-build-id> --build-b <new-build-id> --json

# Export latest feature snapshot in versioned JSON format
kk-codeslice graph export --feature authentication --out ./artifacts/auth.snapshot.json --json

# Export a specific retained build snapshot
kk-codeslice graph export --feature authentication --build-id <build-id> --out ./artifacts/auth.build.snapshot.json --json

# Profile verify/build/risk timings against baseline targets
kk-codeslice graph profile --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts --json

# Rebuild feature graph only when changed files overlap existing feature files
kk-codeslice graph rebuild --request ./examples/authentication.payload.json --changed-files src/features/auth/LoginForm.ts

# Run integration tests for CLI contract coverage
npm run test:integration
```

Initial query surface:

- `impact(symbol)`: traverse downstream edges from a symbol inside a feature slice.
- `upstream(symbol)`: trace incoming callers/dependencies that can reach a symbol.
- `downstream(symbol)`: explicit downstream traversal from a symbol (compatible with impact flow).
- `side-effects(symbol)`: list reachable side effects (db/event/external targets) from a symbol.
- `risk(request, changed_files)`: weighted score based on overlap, downstream propagation, side-effect reachability, and graph coverage.
- `why(from, to)`: shortest explanation path between two graph references inside a feature slice.
- `diff(feature, build_a, build_b)`: added/removed/changed nodes and edges between two retained build snapshots.
- Confidence output: query rows return `confidence_score` + `confidence_label` based on evidence state/source (`verified` vs `inferred`).
- Risk factors output: risk query includes `risk_factors` with `{ value, weight, contribution }` per factor.
- AST resolver diagnostics: inferred `ast_calls` edge metadata includes `{ resolved_module_specifier, resolved_by_tsconfig, resolver_scope }`.

Rebuild strategy:

- Detect changed files from `--changed-files` or `git diff --name-only <base-ref>..<head-ref>`.
- Compare changed files with files already linked to the feature graph.
- Skip rebuild if no overlap.
- If overlap exists and feature graph already exists, apply incremental patch scoped by changed file hunks.
- If no feature graph exists yet, fallback to full build.

Implementation tracking:

- See [README-TRACKING.md](/Users/vijaysingh/code/kodeklarity/kodeklarity-slicegraph/README-TRACKING.md) for missing pieces and milestone status.
- Planned next validation run: execute CLI on a real repository feature on March 5, 2026 to calibrate confidence and edge quality.

## LLM-Driven DX (v0)

Developer prompt in Claude/Cursor/Codex:

- "Use `kk-codeslice`. I am working on authentication feature. Create artifact."

Expected agent actions:

1. Generate payload JSON from discovered boundaries.
2. Run `kk-codeslice artifact create --mode <full|seed|auto> --request <path-or-stdin>`.
3. Return generated request artifact path.

Helper commands:

```bash
# Show full payload template for a feature
kk-codeslice artifact template --feature authentication --mode full

# Show seed payload template (minimal origins-only contract)
kk-codeslice artifact template --feature authentication --mode seed

# Create full intake artifact from a payload file
kk-codeslice artifact create --mode full --request ./examples/authentication.payload.json

# Create seed intake artifact from a minimal payload file
kk-codeslice artifact create --mode seed --request ./examples/authentication.seed.payload.json

# Create intake artifact from stdin and return machine-readable summary/errors
cat ./examples/authentication.payload.json | kk-codeslice artifact create --mode auto --request - --json
```

## Near-Term Build Plan

1. Add deeper type-aware resolution for overloads/polymorphism and DTO mapping edges.
2. Tune confidence gate thresholds from real project telemetry.
3. Define vertical slicing traversal strategy for graph expansion quality and stopping conditions.
4. Add semantic diff summaries grouped by feature layers (UI/API/service/side-effect).
5. Add change-risk regression benchmarks from real repositories.

## Success Criteria

- Higher task accuracy than baseline retrieval.
- Lower token usage per coding task.
- Faster impact analysis for code changes.
- Fewer side-effect regressions during feature changes.
- Reliable graph facts with source traceability.

---

This README is the foundation. Next step is to finalize vertical-slicing traversal rules and AST expansion strategy for graph quality.
