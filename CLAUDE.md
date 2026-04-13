# CLAUDE.md — for agents working on this repo

You are working on **KodeKlarity itself** (the `kk` / `kk-mcp` package). This is the tool — not a project that uses it.

## Context

KodeKlarity is a code graph + agent memory layer for TypeScript projects. See `README.md` for the user-facing pitch, `AGENT.md` for the full agent guide that users reference in their projects.

- CLI entry: `bin/kk.js` → `src/cli.js` → `src/commands.ts`
- MCP entry: `bin/kk-mcp.ts` → `src/mcp-server.ts`
- Graph storage: `src/db.js` (SQLite, schema migrations)
- Graph queries: `src/query.js` (recursive CTEs)
- Framework detection: `src/discover/adapters/*.ts` (one file per framework)
- Type-aware tracing: `src/type-tracer.ts` (uses `ts.createProgram`)
- Import-chain tracing: `src/trace.ts` (BFS through imports)

## Before making changes

Run tests often — the suite is fast (~5s):

```bash
npm run build
npm test
```

33 tests across 15 suites. Keep it green.

## Conventions

- **TypeScript** for new code; `src/*.js` files are legacy (being phased out — see TASKS.md)
- **No LLM calls in the core path.** kk is pure static analysis. Adding an LLM dependency is a product-level decision, not a routine change.
- **One-line commit messages** unless explaining a non-obvious fix. Follow the existing `git log` style.
- **Don't break the MCP tool surface** without discussing. Agents in the wild depend on stable tool names and parameter shapes.
- **The `nodes` and `edges` tables get wiped on every rebuild.** The `memories` table must NEVER be wiped by a rebuild — that's the core invariant of the memory system. Any migration touching storage must preserve this.

## Commit style

- Small, focused commits. One logical change per commit.
- When fixing a bug, explain the root cause in the message, not just the symptom.

## When adding a framework adapter

See README "Contributing" section. New adapters go in `src/discover/adapters/`, get registered in `src/discover/detector.ts`, and need a test fixture.

## Key files to read before changing memory behavior

- `src/db.js` — migration `004_agent_memory` defines the `memories` table + FTS5
- `src/store.ts` — the `storeDiscoveryResult` transaction. It deletes from `nodes` and `edges` only; `memories` must stay untouched
- `src/mcp-server.ts` — 5 memory tools + auto-surface logic in `fetchMemoriesForTraversal`
- `src/commands.ts` — CLI memory subcommands (write/update/read/search/list)

## Publishing

See TASKS.md → "npm publish — ready". `npm publish` triggers `prepublishOnly` (build + test) as a safety net. Never publish without running `npm pack --dry-run` first to inspect tarball contents.
