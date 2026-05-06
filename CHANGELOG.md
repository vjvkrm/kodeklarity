# Changelog

## 0.3.0

### Breaking: Removed `kk risk`

The aggregate 0–100 risk score has been removed (CLI command `kk risk`, MCP tool `kk_risk`, internal `queryRisk`). Reason: every structural field already *is* a risk signal — `breaking_changes`, `tables_touched.writes`, `orphans`, `coverage_action` — and a synthetic composite score added no information beyond what the agent already had to read. Agents now prioritize by inspecting structural fields directly.

**Migration:** if you were scripting against `kk risk` / `kk_risk`, read the relevant fields from `kk precommit --json` (uncommitted) or `kk review --base main --json` (branch) instead. The `breaking_changes[].verdict` field (new — see below) gives you a direct priority signal that the old `risk_score` only approximated.

### New: `kk dashboard` — local web UI

Visual layer over the graph + diff machinery. Run `kk dashboard` from any project root to open `http://127.0.0.1:4421` with two views:

- **Precommit** — closed set, exactly what you changed (uncommitted)
- **Impact** — changed + 1-hop ring of callers/callees

Click any node for a syntax-highlighted diff and metadata. Resizable inspector pane, light/dark theme, keyboard shortcuts (`R` refresh, `1`/`2` switch views, `/` search, `?` help), connected-subgraph highlighting on click. Server binds 127.0.0.1 only, validates Host header (DNS-rebinding defense), strict CSP, no telemetry.

### New: `kk review --base <ref>` — branch-level analysis

Same engine as `kk precommit`, but the diff window is `merge-base(<ref>, HEAD)` → working tree. Captures **all changes since the branch diverged** — committed commits + staged + unstaged. The shape that matters for self-review of a feature branch or PR review of someone else's diff.

Default base is `main`. Output is identical to `kk precommit` plus a new top-level `diff_window` field: `{ base_ref, merge_base, commits_on_branch }`.

Available as CLI (`kk review`) and MCP tool (`kk_review`).

### New: AST-level symbol diff for `breaking_changes`

`kk precommit` and `kk review` now compare each candidate breaking change at the symbol's AST level — not file level. For every existing graph node whose file is in the diff, kk parses both the merge-base version (via `git show`) and the working-tree version, normalizes whitespace, and classifies the result:

- `signature_changed` — declaration line differs (params / return type / exported identity); callers may break — **high signal**
- `removed_or_renamed` — present at base, absent at head — **high signal**
- `body_changed` — body differs but signature unchanged — **medium signal**, behavior may have shifted
- `unchanged` — declaration text identical — **dropped from the report entirely**
- `unknown` — couldn't AST-extract (dynamic export, unparseable, etc.) — kept for safety

The verdict is exposed as a new `verdict` field on each `breaking_changes` entry so agents can prioritize. On a real 7,000-line dogfood diff, this reduced `breaking_changes` from 60 file-granular entries to 10 truly-changed symbols (1 signature change, 9 body changes) — a 6× reduction in noise with no loss of real signal. Net-new symbols in files that didn't exist at the base ref are also filtered out — they surface under `new_symbols`, not `breaking_changes`.

### New: `coverage_action` — agent-actionable feedback loop

`kk precommit` and `kk review` now emit a structured `coverage_action` payload when files in the diff have no boundary nodes. Includes:

- `files` — concrete uncovered list
- `next_steps` — explicit workflow loop (edit config → `kk init --force` → re-run)
- `example_boundary` — copy-pasteable JSON template using the longest-common-prefix glob

Designed for agent consumption: the agent reads the payload, decides per file whether to add a `customBoundary` or list it under the new `ignoreCoverage` config option, then re-runs.

### New: `ignoreCoverage` config option

`.kodeklarity/config.json` now accepts `ignoreCoverage: string[]` — glob patterns for files that are *intentionally* not boundaries (CLI dispatch tables, type-only files, bootstrap entries). Files matching are silenced from `missing_coverage` warnings without being excluded from the graph as a whole.

### Updated agent instructions

The auto-generated `.kodeklarity/AGENT.md` (written by `kk init`) has a new structure:

- `kk_review` documented for branch / PR review
- `kk_precommit` framing tightened to "uncommitted only — pre-commit gate"
- Risk score guidance removed; replaced with a "treat structural fields as risk signals" rubric
- Coverage gap workflow loop documented end-to-end

(Existing repos won't get the new `.kodeklarity/AGENT.md` automatically — the file is first-run-only by design. Delete it and re-run `kk init` to regenerate.)

## 0.2.0

### New: `kk precommit` — pre-commit impact analysis

Analyzes uncommitted changes (staged + unstaged + untracked) against the committed graph. Catches architecture gaps before they land:

- **new_symbols** — boundary nodes you added
- **new_edges** — new connections from your code
- **orphans** — new code nobody calls yet (wiring gaps)
- **tables_touched** — which tables your changes read/write
- **breaking_changes** — modified symbols with downstream dependents
- **missing_coverage** — files with no boundary nodes, symbols with no tests

Nothing is persisted — purely in-memory analysis of your working tree.

Available as CLI (`kk precommit`) and MCP tool (`kk_precommit`).

### Updated agent instructions

- All instruction files (`instructions/CLAUDE.md`, `AGENTS.md`, `cursorrules.md`, `windsurfrules.md`) rewritten to be concise with clear workflow order
- Added mandatory precommit step before every commit
- Added memory maintenance discipline — agents must update/remove stale memories when changing code
- All instruction files now link to `AGENT.md` as the full reference
- Auto-generated `.kodeklarity/AGENT.md` (from `kk init`) updated to match

### Updated AGENT.md

- Added `kk precommit` command documentation
- Added `kk_precommit` to MCP tools table
- Added "Maintaining memories" section — keep memories consistent with code changes
- Updated typical workflow: rebuild → investigate → code → precommit → commit

## 0.1.0

Initial release.

- Code graph: discover boundaries, trace imports, type-aware call chains
- Framework adapters: Next.js, Drizzle, Trigger.dev, NestJS, Express, React, Generic
- Graph queries: impact, upstream, downstream, side-effects, why
- Agent memory: write, update, read, search, list with FTS5
- MCP server
- Config system with customBoundaries, workspace overrides, import aliases
- Git integration: SHA tracking, incremental rebuilds, branch detection
