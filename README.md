# KodeKlarity

CLI tool (`kk`) and MCP server (`kk-mcp`) that builds a code graph for TypeScript projects. Zero-LLM discovery: detects frameworks, traces imports, and builds a full relationship graph in seconds. Designed for AI agents (Claude Code, Codex, Cursor) to understand code relationships, trace impact, and score risk before making changes.

## Quick Start

```bash
npm install -g kodeklarity

# Scan your project and build the graph
kk init

# What breaks if I change this?
kk impact <symbol>

# Risk score for my uncommitted changes
kk risk
```

## Commands

| Command | Description |
|---------|-------------|
| `kk init` | Full scan: detect stack, discover boundaries, trace imports, store graph |
| `kk rebuild` | Incremental rebuild from git diff. Skips if up-to-date. Tracks branch. |
| `kk impact <symbol>` | Downstream blast radius -- what breaks if this changes |
| `kk upstream <symbol>` | What depends on this symbol |
| `kk downstream <symbol>` | What this symbol calls |
| `kk side-effects <symbol>` | DB writes, API calls, events triggered by this symbol |
| `kk why --from X --to Y` | Explain the connection path between two symbols |
| `kk risk` | Zero-arg: reads git diff, returns risk score 0-100 |
| `kk status` | Graph overview: node/edge counts, stack, last build info |

All commands output JSON by default and include confidence scores on every result.

## MCP Server Setup (Claude Code)

Add to your Claude Code MCP config (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "kodeklarity": {
      "command": "npx",
      "args": ["kodeklarity", "mcp"]
    }
  }
}
```

### MCP Tools (10 tools)

`kk_init`, `kk_rebuild`, `kk_impact`, `kk_upstream`, `kk_downstream`, `kk_side_effects`, `kk_why`, `kk_risk`, `kk_status`, `kk_config`

## Framework Support

| Framework | What it detects |
|-----------|----------------|
| **Next.js** | Pages, API routes, server actions, middleware, layouts, revalidatePath/revalidateTag connections |
| **Drizzle** | Table definitions, RLS policies, db.select/insert/update/delete to table edges, relations |
| **NestJS** | Controllers, services, modules, guards, interceptors, route handlers |
| **Express** | Routes (router.get/post/...), middleware (app.use) |
| **React** | Custom hooks (use*), context providers (createContext) |
| **Trigger.dev** | Tasks (task()), jobs (defineJob()) |
| **Generic** | External API calls (fetch), event emissions (.emit/.publish), dynamic dispatch (flagged as gaps) |

Monorepo support: Turborepo, Nx, pnpm workspaces, npm workspaces. Cross-workspace import resolution via package.json exports fields.

## Config System

After `kk init`, a config file is created at `.kodeklarity/config.json`. This file is designed to be edited by agents and developers to improve graph quality.

Key config options:

- **customBoundaries** -- teach kk about project-specific patterns (query layers, service layers, repositories)
- **workspaces** -- override which adapters run on which workspace
- **exclude** -- skip test files, migrations, scripts
- **importAliases** -- add aliases not in tsconfig
- **trace.maxDepth** -- control how deep import tracing goes
- **stack.disabled** -- turn off noisy adapters

After editing config, run `kk rebuild` to update the graph.

## Tested Results (Sastrify Monorepo)

11 workspaces, 752 nodes, 43,767 edges discovered:
96 routes, 132 API routes, 195 server actions, 62 tables, 28 background jobs, 44 services, 178 queries, 12 external APIs.

## Project Structure

```
kodeklarity/
├── bin/kk.js              -- CLI entry point
├── bin/kk-mcp.ts          -- MCP server entry point
├── src/
│   ├── cli.js             -- Command routing
│   ├── commands.ts        -- Top-level commands (impact, upstream, risk, etc.)
│   ├── config.ts          -- Agent-editable config system
│   ├── init.ts            -- kk init orchestration
│   ├── rebuild.ts         -- Incremental rebuild from git diff
│   ├── git.ts             -- Git state, diff, working changes
│   ├── trace.ts           -- Import chain traversal between boundary nodes
│   ├── store.ts           -- SQLite graph storage
│   ├── mcp-server.ts      -- MCP server (10 tools)
│   ├── discover/          -- Discovery engine
│   │   ├── index.ts       -- Orchestrator
│   │   ├── types.ts       -- TypeScript interfaces
│   │   ├── workspace.ts   -- Monorepo workspace detection
│   │   ├── detector.ts    -- Stack detection + adapter registry
│   │   └── adapters/      -- Framework-specific scanners
│   │       ├── nextjs.ts, drizzle.ts, nestjs.ts, express.ts
│   │       ├── react.ts, triggerdev.ts, generic.ts, utils.ts
│   ├── db.js, query.js    -- SQLite schema + query engine (recursive CTEs)
│   ├── ast.js, resolve.js -- TypeScript AST parsing + import resolution
│   └── confidence.js      -- Scoring logic
├── AGENT.md               -- Agent guide
├── TASKS.md               -- Task plan
└── README.md              -- This file
```

## TypeScript Only (v1)

KodeKlarity v1 supports TypeScript projects only. Other languages require their own compiler integration and will come in future versions.
