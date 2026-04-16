# Changelog

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
- Graph queries: impact, upstream, downstream, side-effects, why, risk
- Agent memory: write, update, read, search, list with FTS5
- MCP server with 15 tools
- Config system with customBoundaries, workspace overrides, import aliases
- Git integration: SHA tracking, incremental rebuilds, branch detection
