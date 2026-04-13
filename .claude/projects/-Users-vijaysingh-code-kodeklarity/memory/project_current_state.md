---
name: KodeKlarity current state
description: Full project status as of 2026-04-09. What's built, tested, and ready to ship.
type: project
---

KodeKlarity v0.1.0 — built and tested 2026-04-08/09.

**What it is:** CLI (`kk`) + MCP server (`kk-mcp`) that builds a code graph for TypeScript projects. Framework-aware discovery, deep call chain tracing via ts.createProgram, agent-editable config.

**Tested on:** Sastrify monorepo (11 workspaces, 825 nodes, 5,121 edges). Next.js + Drizzle + Trigger.dev.

**33 tests passing** — unit (config, discovery, adapters) + e2e (full init→query→rebuild cycle).

**CLI commands (10):** init, rebuild, impact, upstream, downstream, side-effects, why, risk, search, status

**MCP tools (12):** kk_init, kk_rebuild, kk_impact, kk_upstream, kk_downstream, kk_side_effects, kk_why, kk_risk, kk_search, kk_status, kk_config, kk_compare

**Key files:**
- `src/discover/` — 7 framework adapters (Next.js, Drizzle, NestJS, Express, React, Trigger.dev, Generic)
- `src/type-tracer.ts` — deep call chain tracing via ts.createProgram (follows through intermediate functions)
- `src/trace.ts` — file-level import tracing with workspace package resolution
- `src/mcp-server.ts` — 12 MCP tools
- `src/commands.ts` — all CLI commands including search
- `src/config.ts` — agent-editable config (customBoundaries, workspace overrides)
- `src/compact.ts` — token-efficient output for agents
- `src/cli.js` — 213 lines, clean (legacy removed)
- `instructions/` — setup files for Claude/Codex/Cursor/Windsurf

**What was improved on day 2:**
- Deep call chain tracing (follows through intermediate functions, not just boundary nodes)
- 1,389 multi-hop edges found (depth 2+) that old tracer missed
- Legacy code removed (cli.js: 1,734 → 213 lines, deleted build.js/intake.js/validate-request.js/graph.js)
- db.query.X.findMany() pattern added to Drizzle adapter
- Dynamic import() detection added to type tracer
- kk search command + MCP tool
- Config --force no longer resets customBoundaries
- chmod +x fix in build script

**Installed locally:** `npm link` — `kk` and `kk-mcp` available globally.
**MCP configured:** Added to Sastrify `.mcp.json` and `.claude/settings.local.json`.

**What's left:**
- npm publish setup
- Test fixtures for NestJS, Express, React, Generic adapters
- Real-world testing over a few weeks to find edge cases
- Community: open-source, accept adapter contributions

**How to apply:** Run `npm test` to verify. Run `kk init` in any TS project. For Sastrify: `cd ~/SastrifyCode/sastrify-platform && kk init`.
