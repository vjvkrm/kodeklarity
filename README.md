<div align="center">

# 🧠 KodeKlarity

### A living knowledge layer for your codebase — built by your AI agents, used by your AI agents.

*Code graph + persistent memory. Agents shape it when they spot gaps, write to it when they learn.<br>Every session, it understands your codebase better than the last.*

[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white)](#)
[![MCP](https://img.shields.io/badge/MCP-compatible-8B5CF6)](#)
[![Zero LLM](https://img.shields.io/badge/Zero_LLM-pure_static_analysis-22C55E)](#)
[![Memory](https://img.shields.io/badge/Agent_Memory-persistent-F59E0B)](#)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-yellow.svg)](./LICENSE)

</div>

---

<br>

## Every coding agent starts from zero. That's the problem.

Your coding agent figures out your billing flow, discovers a gotcha about Stripe ordering, ships a fix. Next session, it has no memory. Switch tools — the new one starts from scratch. Every session, every agent, rediscovers the same things — and guesses based on grep, missing the indirect connections that break production.

**KodeKlarity is the shared knowledge layer your agents build and use.**

One persistent brain that every coding agent reads *and writes*. The graph maps your whole codebase automatically (symbol-level accuracy, not grep). Memory captures what agents learn — gotchas, decisions, warnings — attached to the exact functions and tables they apply to.

And here's the twist: **agents maintain it themselves.**

- When an agent spots a missing layer in the graph (your service layer isn't being traced), it edits `.kodeklarity/config.json` to add a `customBoundary`, rebuilds, and the graph permanently improves. Every future session inherits it.
- When an agent discovers something non-obvious, it writes a memory tied to the relevant node. The next agent sees it automatically during impact analysis.

You don't configure kk. You don't train it. Your agents shape it as they work — and every session benefits from every session before it.

Zero LLM tokens. Zero guessing. Knowledge compounds.

<br>

---

<br>

## What your agent sees when it asks about a symbol

```
$ kk impact updateSubscription

  updateSubscription (server_action)
    ├── invokes_service → withServiceContext
    ├── writes_table    → subscriptions
    ├── writes_table    → invoices
    ├── triggers_job    → send-billing-email
    ├── revalidates     → /billing page
    └── 47 downstream connections

  3 memories from past sessions:
    [gotcha]  updateSubscription
      "Must sync Stripe before DB write — reconcileStripeState fixes mismatches"
    [decision] withServiceContext
      "Mandatory RLS wrapper. Direct queries silently return empty."
    [warning] subscriptions table
      "Soft-delete only. Hard-delete breaks Stripe webhook reconciliation."
```

One query returns the full map *plus* every relevant thing past agents learned. No hunting through CLAUDE.md files, no rediscovering gotchas, no grepping for callers.

<br>

---

<br>

## Why this is different

| | Without KodeKlarity | With KodeKlarity |
|---|---|---|
| 🧩 **Codebase understanding** | Agent uses grep, misses indirect deps, cross-workspace imports, framework edges | Symbol-level accuracy via TypeScript compiler. 750+ nodes, 43k+ edges on real monorepos. |
| 🧠 **Learning across sessions** | Every session starts fresh. Same gotchas rediscovered. Same mistakes repeated. | Memories persist and auto-surface at the right moment. |
| 🔀 **Cross-tool knowledge** | Each tool has its own memory silo | One shared brain across every coding agent — MCP-compatible out of the box. |
| 💥 **Accuracy** | Agent guesses impact from pattern matching | Exact downstream traversal with confidence scores. |
| 🌱 **Maintenance** | You configure rules, docs, context files manually | Agents add missing layers to config and write memories as they work. Zero human config. |
| 💰 **Cost** | Rediscovery burns tokens every session | Static analysis + persistent memory. Zero LLM tokens. |
| 😴 **Risk before commit** | Hope the tests catch it | `kk precommit` catches orphans, unwired code, breaking changes. `kk risk` scores 0–100 from graph impact. |

<br>

---

<br>

## Built for real workflows

🌱 **Self-improving, zero-config** — Agents spot missing layers, add them to config, and rebuild. Agents discover gotchas, write them as memories. You never edit a rules file.

🎮 **Vibe coding, safely** — Move fast, let KodeKlarity watch your back. Your agent sees the map, respects past decisions, scores your risk before commit.

🤖 **Agents that stop guessing** — Impact check before every change, past gotchas surfaced automatically, new learnings written back. Fewer rollbacks.

🔄 **Works across every coding agent** — Knowledge compounds across tools. What one session learns, every future session inherits.

👀 **Code reviews in minutes** — Reviewer sees exactly what a PR affects: pages, tables, jobs, APIs. Plus memories explaining *why* the code is shaped this way.

🚀 **Fast onboarding** — "Show me everything connected to payments" is one command. Humans and agents ramp in minutes, not weeks.

🔧 **Refactor with confidence** — Know the blast radius before you start. See past decisions attached to every function.

<br>

---

<br>

## How it works

**Pure static analysis. No LLM. Framework-aware. Agent-maintained.**

### The baseline — automatic

1. **Discovers boundaries** — Detects Next.js, Drizzle, NestJS, Express, Trigger.dev from `package.json`. Knows `'use server'` is a mutation boundary, `pgTable()` is a data boundary, `task()` is an async boundary.

2. **Traces with the TypeScript compiler** — Uses `ts.createProgram` (the real type checker) to resolve calls through generics, aliases, barrel re-exports, and monorepo imports. Symbol-level precision.

This gets you ~80–90% of your codebase's connections out of the box, in seconds.

### The living part — agents fill the gaps

3. **Agents teach the graph** — Missing a service layer? An agent edits `.kodeklarity/config.json` to add a `customBoundary`, runs `kk rebuild`, and the layer is now permanently mapped. Same for query layers, validators, repository patterns — anything project-specific.

4. **Agents write memory** — Discovered a gotcha? `kk_memory_write` stores it against the node. Discovered an intentional non-obvious decision? Same. Next agent calling `kk_impact` on that node gets the memory back automatically.

5. **It compounds** — Config and memory both live in `.kodeklarity/` and survive rebuilds. Commit the directory to share improvements across your team, or keep it local. Either way, your future self inherits every past agent's understanding.

**Tested on production monorepos:** 750+ nodes · 43,000+ connections · 5 seconds · 0 LLM tokens.

---

## Setup — 3 steps

### 1. Install

```bash
npm install -g kodeklarity
kk init        # builds the graph for your project
```

### 2. (Optional) Wire up the MCP server

Skip this if you want your agent to use `kk` via shell commands. Add it if you want MCP tools (`kk_impact`, `kk_memory_write`, …) directly callable.

```json
{
  "mcpServers": {
    "kodeklarity": {
      "command": "kk-mcp"
    }
  }
}
```

Where to put it: `.claude/settings.json` (Claude Code) · your tool's MCP config file (Cursor, Windsurf, Codex, etc).

### 3. Paste rules into your agent's rules file

Grab the right drop-in file from **[`instructions/`](./instructions)** and paste its contents into your project's rules file. Modify freely for your project — loosen or tighten the memory-writing bar however your team prefers.

| Tool | Grab this | Paste into |
|------|-----------|-------------|
| Claude Code | [`instructions/CLAUDE.md`](./instructions/CLAUDE.md) | `./CLAUDE.md` (or `~/.claude/CLAUDE.md` for global) |
| Codex | [`instructions/AGENTS.md`](./instructions/AGENTS.md) | `./AGENTS.md` |
| Cursor | [`instructions/cursorrules.md`](./instructions/cursorrules.md) | `./.cursorrules` (or `./.cursor/rules/kodeklarity.md`) |
| Windsurf | [`instructions/windsurfrules.md`](./instructions/windsurfrules.md) | `./.windsurfrules` |
| Any other MCP-compatible tool | any of the above | your tool's rules file |

All four files have the same content — just filename and headline differ. Your agent can use **CLI** (`kk impact foo`) or **MCP** (`kk_impact`) interchangeably.

**What the rules teach your agent:**

- **USE** the graph before every change — check impact, read surfaced memories
- **PRECOMMIT** before every commit — catch orphans, breaking changes, missing tests
- **BUILD** the graph when layers are missing — add `customBoundary` rules to `.kodeklarity/config.json`
- **WRITE memory** selectively (non-obvious + durable + actionable) and maintain existing memories when code changes

---

## Commands

| Command | What it does |
|---------|-------------|
| `kk init` | Scan project, discover boundaries, trace imports, store graph |
| `kk rebuild` | Incremental rebuild — skips if no changes, tracks branch |
| `kk impact <symbol>` | Downstream blast radius |
| `kk upstream <symbol>` | What calls / depends on this |
| `kk downstream <symbol>` | What this calls |
| `kk side-effects <symbol>` | DB writes, API calls, events triggered |
| `kk why --from X --to Y` | Explain how two symbols connect |
| `kk precommit` | Pre-commit analysis: orphans, new symbols, tables touched, breaking changes |
| `kk risk` | Risk score (0-100) for uncommitted changes |
| `kk search <term>` | Find nodes by name, file, or keyword |
| `kk status` | Graph overview |
| `kk memory write <content> [--node <symbol>]` | Save a memory attached to a node (or global) |
| `kk memory update <memory_id>` | Update an existing memory |
| `kk memory read [--node <symbol>]` | Read memories for a symbol (or global wiki) |
| `kk memory search <query>` | Full-text search across all memories |
| `kk memory list [--category <cat>]` | Browse all memories |

Add `--json` to any command for machine-readable output. Add `--depth N` to control traversal depth.

## Memory categories

| Category | When to use |
|----------|-------------|
| `gotcha` | Watch out — easy to get wrong, not obvious from the code |
| `decision` | Why it's done this way — don't "fix" it |
| `warning` | Fragile, dangerous, or deprecated |
| `context` | General background |
| `wiki` | Global knowledge, not tied to any node |

Memories survive every `kk init` / `kk rebuild`. Full-text searchable (SQLite FTS5 with prefix matching). Auto-surface in `kk_impact` / `kk_upstream` / `kk_downstream` / `kk_side_effects`. Orphaned memories flagged `stale: true` when the node is deleted.

## MCP tools (16)

**Graph:** `kk_init`, `kk_rebuild`, `kk_impact`, `kk_upstream`, `kk_downstream`, `kk_side_effects`, `kk_why`, `kk_risk`, `kk_precommit`, `kk_status`, `kk_config`, `kk_search`, `kk_compare`

**Memory:** `kk_memory_write`, `kk_memory_update`, `kk_memory_read`, `kk_memory_search`, `kk_memory_list`

---

## Framework Support

**TypeScript ecosystem only (v1).** Each adapter understands framework-specific patterns that generic tools miss.

### Fully Supported & Tested

| Framework | What it discovers |
|-----------|------------------|
| **Next.js** | Pages, API routes, server actions, middleware, layouts, `revalidatePath` / `revalidateTag` edges |
| **Drizzle ORM** | Tables (`pgTable`/`sqliteTable`), RLS policies, `db.select/insert/update/delete` edges, relations |
| **Trigger.dev** | Tasks (`task()`), jobs (`defineJob()`) |

### Available (Coming Soon: Full Test Coverage)

| Framework | What it discovers | Status |
|-----------|------------------|--------|
| **NestJS** | Controllers, services, modules, guards, interceptors, route handlers with DI awareness | Adapter built, needs test fixtures |
| **Express** | Routes (`router.get/post`...), middleware chains (`app.use`) | Adapter built, needs test fixtures |
| **React** (standalone) | Custom hooks (`use*`), context providers (`createContext`) | Adapter built, needs test fixtures |
| **Generic patterns** | External API calls (`fetch`), event emitters (`.emit/.publish`), dynamic dispatch (flagged as gaps) | Adapter built, needs test fixtures |

### Planned / Community Contributions Welcome

| Framework | What we'd detect | Help wanted |
|-----------|-----------------|-------------|
| **Prisma** | Models from `schema.prisma`, relations, `prisma.user.findMany()` edges | [Contribute](#contributing) |
| **tRPC** | Routers, procedures, middleware chains | [Contribute](#contributing) |
| **Hono** | Routes, middleware | [Contribute](#contributing) |
| **Elysia** | Routes, guards, plugins | [Contribute](#contributing) |
| **Supabase** | Client calls (`supabase.from('users').select()`) | [Contribute](#contributing) |
| **Clerk / Auth.js** | Auth boundaries, session checks | [Contribute](#contributing) |
| **GraphQL** | Resolvers, schema types, subscriptions | [Contribute](#contributing) |
| **Fastify** | Routes, plugins, hooks | [Contribute](#contributing) |

### Monorepo Support

Turborepo, Nx, pnpm workspaces, npm workspaces — all supported. Cross-workspace import resolution via `package.json` exports fields.

---

## Contributing

KodeKlarity is open to contributions — especially **new framework adapters**. Each adapter is a single TypeScript file (~100-200 lines) that teaches `kk` about a framework's patterns.

### Adding a new framework adapter

1. **Fork the repo** and create a branch

2. **Create the adapter** at `src/discover/adapters/<framework>.ts`:
   ```typescript
   import type { FrameworkAdapter } from "../types.js";
   import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

   export const myFrameworkAdapter: FrameworkAdapter = {
     name: "myframework",
     
     detect(packageJson) {
       const version = getDepVersion(packageJson, "my-framework");
       if (!version) return null;
       return { name: "MyFramework", version, adapter: "myframework" };
     },

     async scan(workspace, repoRoot) {
       const nodes = [];
       const edges = [];
       // Find framework-specific patterns using glob + regex
       // Create BoundaryNode for each discovered boundary
       // Create BoundaryEdge for framework-specific connections
       return { adapter: "myframework", nodes, edges };
     },
   };
   ```

3. **Register it** in `src/discover/detector.ts` — add to the `ADAPTERS` array

4. **Create a test fixture** at `tests/fixtures/<framework>-app/` with a small sample project

5. **Add tests** in `tests/discover.test.js`

6. **Submit a PR** with:
   - The adapter file
   - Test fixture
   - Tests
   - Updated README (move framework from "Planned" to "Available")

### Contribution Guidelines

- One adapter per PR
- Include at least 3 test cases (detection, node discovery, edge discovery)
- Use `shouldExclude()` from utils to filter `node_modules`, `dist`, etc.
- Use `makeNodeId()` for consistent node ID format
- Framework detection should check `package.json` dependencies
- Keep adapters simple — pattern matching via glob + regex, not full parsing

## Self-Improving Config

After `kk init`, a config file is created at `.kodeklarity/config.json`. AI agents (or developers) edit this to improve the graph:

```json
{
  "customBoundaries": [
    {
      "name": "query-layer",
      "kind": "query",
      "glob": "src/lib/queries/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Data access layer"
    }
  ],
  "workspaces": {
    "packages/db": { "adapters": ["drizzle", "generic"] }
  }
}
```

One config edit found 222 new nodes and 15,814 new edges. Config persists across sessions — every agent benefits from the previous agent's improvements.

## Git Integration

- Stores git SHA + branch on each build
- `kk rebuild` diffs against last build — skips if nothing changed
- Branch switch triggers full rebuild
- `kk risk` reads unstaged + staged + untracked changes

## Real-World Results

**Tested on a production Next.js + Drizzle monorepo:**

| Metric | Result |
|--------|--------|
| Nodes discovered | 750+ (routes, API routes, server actions, tables, jobs, services, queries) |
| Edges traced | 43,000+ |
| Type-checker resolved edges | 268 (symbol-level precision) |
| Import-usage resolved edges | 368 (symbol-to-symbol via import analysis) |
| Discovery time | ~5 seconds |
| LLM tokens used | 0 |
| Upstream query (auth function) | 686 connections (349 routes, 331 actions) |
| Impact query (server action) | 3,800+ downstream connections across 3 depth levels |

---

## Technical Details

### Graph Storage

SQLite database at `.kodeklarity/index/graph.sqlite`. Queries use recursive CTEs for traversal. Nodes and edges have confidence scores (`high`/`medium`/`low`).

Contains three persistent stores:
- `nodes`, `edges` — rebuilt on every `kk init` / `kk rebuild`
- `memories` — agent-written knowledge, **survives rebuilds**, indexed by FTS5
- `builds`, `build_nodes`, `build_edges` — historical snapshots per build

### Type-Aware Tracing

Uses `ts.createProgram` for whole-project type resolution alongside file-level import tracing. Two precision tiers:

1. **Symbol-level** (type_trace) — `updateUser` calls `requireAuth` (resolved through the TypeScript type checker)
2. **File-level** (ast_trace) — covers cross-workspace imports and patterns the type checker can't resolve

### Node Kinds

`route`, `api_route`, `server_action`, `layout`, `middleware`, `controller`, `service`, `module`, `guard`, `interceptor`, `table`, `rls_policy`, `background_job`, `external_api`, `event`, `hook`, `context`, `query`

### Edge Types

`uses_table`, `reads_table`, `writes_table`, `calls`, `invokes_action`, `invokes_service`, `queries_data`, `triggers_job`, `revalidates`, `imports`, `external_call`, `calls_external`, `emits_event`, `uses_hook`, `uses_context`, `relates_to`

### Project Structure

```
bin/kk.js                    CLI entry point
bin/kk-mcp.ts                MCP server entry point
src/
  cli.js                     Command routing
  commands.ts                Simplified commands (impact, upstream, risk...)
  config.ts                  Agent-editable config system
  init.ts                    kk init orchestration
  rebuild.ts                 Incremental rebuild
  review-graph.ts            Pre-commit analysis (kk precommit)
  git.ts                     Git state, diff, branch tracking
  trace.ts                   File-level import chain traversal
  type-tracer.ts             Type-aware tracing via ts.createProgram
  store.ts                   SQLite graph storage
  mcp-server.ts              MCP server (15 tools incl. agent memory)
  discover/                  Discovery engine
    index.ts                 Orchestrator
    workspace.ts             Monorepo workspace detection
    detector.ts              Stack detection + adapter registry
    adapters/                One file per framework
  db.js, query.js            SQLite schema + recursive CTE queries
  ast.js, resolve.js         AST parsing + import resolution
  confidence.js              Scoring logic
```

## Language Support

TypeScript only (v1). Each additional language requires its own compiler integration — Python, Go, Java planned for future versions.

## License
AGPL-3.0 — Free to use, modify, and distribute. If you offer it as a service, you must release your changes. 