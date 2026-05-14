# Contributing to KodeKlarity

Thanks for your interest. kk is small, focused, and intentionally minimal — keep contributions in that spirit.

## Repo orientation

- **CLI entry**: `bin/kk.js` → `src/cli.js` → `src/commands.ts`
- **MCP entry**: `bin/kk-mcp.ts` → `src/mcp-server.ts`
- **Graph storage**: `src/db.js` (SQLite, schema migrations)
- **Graph queries**: `src/query.js` (recursive CTEs)
- **Discovery**: `src/discover/index.ts` + `src/discover/detector.ts`
- **Framework adapters**: `src/discover/adapters/*.ts` (one file per framework)
- **Memory operations**: `src/memory/core.ts` — single source of truth for both CLI and MCP
- **Type-aware tracing**: `src/type-tracer.ts` (uses `ts.createProgram`)

See `CLAUDE.md` for invariants (especially: the `memories` table is never wiped on rebuild).

## Before submitting

```bash
npm run build
npm test         # ~10s, 96 tests across 21 suites — keep green
```

## What we welcome

- **Bug fixes** with a regression test.
- **Framework adapters** — see [docs/CONTRIBUTING-ADAPTERS.md](docs/CONTRIBUTING-ADAPTERS.md) for the full guide. Adapters are how kk understands more frameworks; this is the highest-leverage contribution path.
- **Documentation** — clarifications, examples, fixing stale references.
- **Performance fixes** — sub-second query latency is a load-bearing property; PRs that improve it are welcome.

## What to discuss before sending a large PR

- New MCP tools (the surface area is intentionally small; we'd prefer enhancements over additions).
- Changes to the memory schema (`memories` table, FTS indexes).
- Changes to the `FrameworkAdapter` interface (forces all adapters to update).
- Anything that adds an LLM call to the core path — kk is deterministic static analysis on purpose.

Open an issue first, or draft a sketch in a PR description.

## Conventions

- **TypeScript** for new code; `src/*.js` files are legacy and being phased out.
- **One-line commit subjects** under 50 chars unless explaining a non-obvious fix. Follow the existing `git log` style.
- **Tests for new behavior**. Don't ship a feature without a test for the path you're adding.
- **No LLM calls in the core path.** Memory writes go through `writeMemory`, which the agent calls deliberately — not auto-captured.
- **Don't break the MCP tool surface** without discussion. Agents in the wild depend on stable tool names and parameter shapes.

## Licensing

By contributing you agree your contributions are licensed under AGPL-3.0, matching the project license.
