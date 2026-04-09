<div align="center">

# 🔍 KodeKlarity

### Your codebase has thousands of hidden connections.<br>Now you can see all of them.

 "Make Claude & Codex actually understand your codebase"

*The code graph that gives AI agents — and developers — the full picture<br>before a single line of code is changed.*

[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white)](#)
[![MCP](https://img.shields.io/badge/MCP-compatible-8B5CF6)](#)
[![Zero LLM](https://img.shields.io/badge/Zero_LLM-pure_static_analysis-22C55E)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#)

</div>

---

<br>

> 🎯 **Install it. Tell Claude or Codex to use it. That's it.**
>
> You don't learn a new tool. You don't change your workflow. You just give your AI assistant the ability to see how your entire codebase connects — every page, every API, every database table, every background job. It checks impact before making changes, catches ripple effects you'd miss, and scores risk on every diff.
>
> **Your AI assistant gets smarter. Your code gets safer. You ship faster.**

<br>

## ✨ Built for how teams actually work

🎮 **Vibe coding without the fear** — Move fast, let KodeKlarity watch your back. It catches the ripple effects you'd miss.

🤖 **Make Claude & Codex actually understand your codebase** — They stop guessing and start seeing the full map before touching any code. Fewer rollbacks, fewer "what happened?" moments.

👀 **Code reviews in minutes, not hours** — Reviewer sees exactly what a PR affects: which pages, tables, jobs, and APIs. No more guessing.

🚀 **New team member? No problem** — "Show me everything connected to payments" is a single command. Onboarding goes from weeks to days.

🔧 **Refactor with confidence** — Know the blast radius before you start. Not after CI fails.

😴 **Ship to production, sleep at night** — Risk score tells you if your diff is safe. Before you push.

<br>

---

<br>

## 🔄 Before & After

| | Before KodeKlarity 😰 | After KodeKlarity 😎 |
|---|---|---|
| 💥 | *"I changed the user service and the billing page broke. How?"* | *"Changing user service affects 3 pages, 2 background jobs, and the billing API. Here's the chain."* |
| 🤔 | *"Is it safe to refactor this?"* | *"This function has 686 dependents. Here are the 12 most critical ones."* |
| 📊 | *"How risky is this pull request?"* | *"Risk score: 73/100. Touches 4 database tables and triggers 2 external API calls."* |
| 🤖 | *"My AI assistant made a change that broke something downstream"* | *Claude/Codex checks impact **before** making changes. Every time. Automatically.* |

<br>

---

<br>

## 🔌 Install once, every AI session gets better

<div align="center">

**Claude Code** · **Codex** · **Cursor** · **Windsurf** · *any MCP-compatible agent*

</div>

```bash
npm install -g kodeklarity
```

That's the setup. KodeKlarity runs as a background tool your AI assistant calls automatically. No extra prompting. No copy-pasting context. No new commands to memorize. Just tell Claude *"use kk to check impact before making changes"* and it handles the rest.

<br>

---

<br>

## ⚡ See it in action

```
$ kk impact updateUser

  updateUser
    ├── affects     → Settings page
    ├── depends on  → Authentication
    ├── connects to → User sync service
    ├── touches     → Users table
    ├── touches     → Sessions table
    └── 847 total connections found
```

```
$ kk risk

  Changed files: 4
  Affected nodes:      12
  Downstream impacts:  89
  Side effects:        3
  Risk score:          73/100 (high)
```

<br>

## 🧩 How it works

| Step | What happens |
|------|-------------|
| **1. `kk init`** | Scans your project in seconds. Understands Next.js, Drizzle, NestJS, Express, Trigger.dev out of the box. Zero config needed. |
| **2. Builds a map** | Every route, API, service, database table, and background job — plus how they connect to each other. |
| **3. Ask anything** | What breaks if I change this? What depends on that? How risky are my changes? Answers in milliseconds. |
| **4. Gets smarter** | Your AI assistant tunes the map over time by editing a simple config file. Every session, more accurate. Automatically. |

<div align="center">

**Tested on production monorepos: 750+ components · 43,000+ connections · 5 seconds · Zero AI cost**

</div>

## How It Works

**Zero LLM. Pure static analysis. Framework-aware.**

1. **Discovers boundaries automatically** — Reads your `package.json`, detects Next.js, Drizzle, NestJS, Express, Trigger.dev. Knows that `'use server'` is a mutation boundary, `pgTable()` is a data boundary, `task()` is an async boundary. No config needed.

2. **Traces relationships with the TypeScript compiler** — Uses `ts.createProgram` (the actual TypeScript type checker) to resolve which function calls which, through generics, aliases, barrel re-exports, and monorepo workspace imports. Symbol-level precision, not grep.

3. **Gets smarter every session** — AI agents edit `.kodeklarity/config.json` to teach it about project-specific patterns (your query layer, your service layer, your validation schemas). Next `kk rebuild` picks up the new patterns. Config persists across sessions — every agent benefits from previous improvements.

**Result on a production monorepo:** 750+ nodes, 43k+ edges. Routes, server actions, tables, background jobs — all connected. 5 seconds, 0 tokens.

---

## Quick Start

```bash
npm install -g kodeklarity

# Build the graph
kk init

# Query it
kk impact <symbol>          # What breaks if I change this?
kk upstream <symbol>        # What depends on this?
kk risk                     # Risk score for my current changes
```

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
| `kk risk` | Risk score (0-100) for uncommitted changes |
| `kk search <term>` | Find nodes by name, file, or keyword |
| `kk status` | Graph overview |

Add `--json` to any command for machine-readable output. Add `--depth N` to control traversal depth.

## MCP Server

10 tools for AI agents: `kk_init`, `kk_rebuild`, `kk_impact`, `kk_upstream`, `kk_downstream`, `kk_side_effects`, `kk_why`, `kk_risk`, `kk_status`, `kk_config`

### Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "kodeklarity": {
      "command": "kk-mcp"
    }
  }
}
```

### Cursor / Windsurf / Other MCP Clients

```json
{
  "mcpServers": {
    "kodeklarity": {
      "command": "node",
      "args": ["/path/to/kodeklarity/dist/bin/kk-mcp.js"]
    }
  }
}
```

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
  git.ts                     Git state, diff, branch tracking
  trace.ts                   File-level import chain traversal
  type-tracer.ts             Type-aware tracing via ts.createProgram
  store.ts                   SQLite graph storage
  mcp-server.ts              MCP server (10 tools)
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