# KodeKlarity Agent Guide

You are working with `kk` — a code graph CLI that maps relationships in TypeScript projects. Use it to understand impact, trace dependencies, and make safer code changes.

## Quick Start

```bash
# First time: scan the project and build the graph
kk init

# Check what breaks if you change a file
kk graph query impact --feature __global__ --symbol <symbolName> --depth 4 --db-path .kodeklarity/index/graph.sqlite --json

# Check upstream callers of a symbol
kk graph query upstream --feature __global__ --symbol <symbolName> --depth 4 --db-path .kodeklarity/index/graph.sqlite --json
```

## Commands

### `kk init [--force] [--json]`

Scans the entire project, discovers boundaries, traces import relationships, and stores the graph.

**What it does:**
1. Detects monorepo workspaces (Turborepo, Nx, pnpm, npm workspaces)
2. Detects framework stack per workspace (Next.js, Drizzle, NestJS, Express, Trigger.dev, React)
3. Runs framework-specific adapters to find boundary nodes (routes, server actions, tables, jobs, etc.)
4. Traces import chains between boundary nodes to create edges
5. Stores graph in `.kodeklarity/index/graph.sqlite`
6. Generates or updates `.kodeklarity/config.json`
7. Records current git SHA for incremental rebuilds

**When to run:**
- First time opening a project
- After pulling significant changes
- After editing `.kodeklarity/config.json`
- Use `--force` to regenerate config from scratch

**Output (JSON mode):**
- `graph.nodes` / `graph.edges` — count of discovered items
- `nodes_by_kind` — breakdown by type (route, server_action, table, etc.)
- `gaps` — files that need agent review (dynamic dispatch, eval, etc.)
- `boundary_nodes` / `boundary_edges` — full list of discovered items
- `config_path` — path to the config file

### `kk graph query impact --feature __global__ --symbol <name> --depth <n> --db-path .kodeklarity/index/graph.sqlite --json`

Traces downstream impact from a symbol. "If I change this, what else is affected?"

**Use when:** About to modify a function, component, or service and need to know the blast radius.

### `kk graph query upstream --feature __global__ --symbol <name> --depth <n> --db-path .kodeklarity/index/graph.sqlite --json`

Traces upstream callers. "What depends on this? What calls this?"

**Use when:** Changing a shared function and need to know all callers.

### `kk graph query side-effects --feature __global__ --symbol <name> --depth <n> --db-path .kodeklarity/index/graph.sqlite --json`

Finds reachable side effects (DB writes, external API calls, event emissions).

**Use when:** Need to understand what a change triggers beyond its direct callers.

### `kk graph query risk --request <path> --changed-files <csv> --db-path .kodeklarity/index/graph.sqlite --json`

Computes a risk score for a set of changed files based on downstream impact, side-effect reach, and graph coverage.

**Use when:** Reviewing a PR or before committing to assess change risk.

### `kk graph query why --feature __global__ --from <symbol> --to <symbol> --depth <n> --db-path .kodeklarity/index/graph.sqlite --json`

Explains the shortest path between two symbols in the graph.

**Use when:** Need to understand how two seemingly unrelated pieces of code are connected.

## Config: `.kodeklarity/config.json`

The config file controls how `kk init` discovers boundaries. **You should edit this file** to improve graph quality for the specific project.

### What you can do:

**1. Fix workspace adapter assignments:**

If a workspace is scanning with wrong adapters (e.g., `packages/db` shouldn't run the Next.js adapter):

```json
{
  "workspaces": {
    "packages/db": { "adapters": ["drizzle", "generic"] },
    "packages/types": { "adapters": ["generic"] }
  }
}
```

**2. Add custom boundary patterns:**

If the project has a query layer, service layer, repository pattern, or any intermediate layer that `kk` doesn't auto-detect:

```json
{
  "customBoundaries": [
    {
      "name": "query-layer",
      "kind": "query",
      "glob": "src/lib/queries/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Data access / query layer function"
    },
    {
      "name": "services",
      "kind": "service",
      "glob": "src/lib/services/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Business logic service function"
    },
    {
      "name": "repositories",
      "kind": "repository",
      "glob": "src/repositories/*.ts",
      "symbolPattern": "export class",
      "reason": "Repository pattern data access class"
    }
  ]
}
```

**3. Disable noisy adapters:**

```json
{
  "stack": {
    "disabled": ["react"]
  }
}
```

**4. Add exclude patterns:**

```json
{
  "exclude": [
    "**/*.test.ts",
    "**/*.spec.ts",
    "scripts/**",
    "migrations/**"
  ]
}
```

**5. Add import aliases not in tsconfig:**

```json
{
  "importAliases": {
    "@/": "src/",
    "~db/": "packages/db/src/"
  }
}
```

**6. Adjust trace depth:**

```json
{
  "trace": {
    "maxDepth": 5,
    "excludeTypeOnlyImports": true
  }
}
```

### Workflow for improving graph quality:

1. Run `kk init --json` and examine the output
2. Check `nodes_by_kind` — are all architectural layers represented?
3. If missing a layer (queries, services, repositories), add a `customBoundary` to config
4. Check `gaps` — review flagged files and determine if edges need manual addition
5. Re-run `kk init` — graph should improve
6. Test with `kk graph query impact` on a known symbol — verify the chain looks right

## Graph Model

- **One graph per repo** — covers all workspaces in a monorepo
- **Node kinds:** `route`, `api_route`, `server_action`, `layout`, `middleware`, `controller`, `service`, `module`, `guard`, `interceptor`, `table`, `rls_policy`, `background_job`, `external_api`, `event`, `hook`, `context`, `query`, `repository` (custom)
- **Edge types:** `invokes_action`, `calls`, `triggers_job`, `revalidates`, `imports`, `external_call`, `reads_table`, `writes_table`, `uses_table`, `calls_external`, `relates_to`, `invokes_service`, `uses_hook`, `uses_context`, `emits_event`
- **Feature name:** Always `__global__` for the whole-project graph
- **Confidence scores:** Every query result includes `confidence_score` (0-100) and `confidence_label` (high/medium/low)

## Node ID Format

Node IDs follow the pattern: `<kind>:<file_path_without_extension>:<symbol>`

Examples:
- `table:packages/db/src/schema:users`
- `server_action:src/lib/actions/contracts:createContract`
- `route:src/app/(customer)/dashboard/page:/dashboard`
- `background_job:src/trigger/jobs/ai-extraction:extract-contract-pdf`

## How to Adapt and Improve the Graph

After running `kk init`, the graph captures ~80-90% of relationships automatically. Follow this process to improve it to 95%+.

### Step 1: Assess what was found

```bash
kk init --json
```

Check the output:
- `nodes_by_kind` — which architectural layers are represented?
- `edges_by_type` — are there cross-layer edges (e.g., `uses_table`, `invokes_service`)?
- `gaps` — which files have patterns kk couldn't resolve?

**Ask yourself:** Does the project have layers that aren't showing up? Common missing layers:
- Query/repository layer (data access functions that wrap ORM calls)
- Service layer (business logic between actions/controllers and data access)
- Validation layer (Zod schemas, validators)
- Middleware chains (auth checks, rate limiting)
- Event handlers (listeners/subscribers)
- Webhook handlers

### Step 2: Explore the project structure

Read the project's directory structure to understand its architecture:

```bash
ls src/lib/          # Common location for business logic
ls src/services/     # Service layer
ls src/queries/      # Query/repository layer
ls packages/         # Monorepo packages
```

Look at how files import each other. Open a server action file and trace its imports:
- Does it import from a service layer? → Add `customBoundary` for services
- Does it import from a query layer? → Add `customBoundary` for queries
- Does it import from a shared package? → Verify workspace import resolution is working

### Step 3: Add custom boundaries to config

Edit `.kodeklarity/config.json` to teach kk about missing layers:

```json
{
  "customBoundaries": [
    {
      "name": "query-layer",
      "kind": "query",
      "glob": "src/lib/queries/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Data access / query layer function"
    },
    {
      "name": "services",
      "kind": "service",
      "glob": "src/lib/services/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Business logic service function"
    },
    {
      "name": "validators",
      "kind": "validator",
      "glob": "src/lib/validations/*.ts",
      "symbolPattern": "export const \\w+Schema",
      "reason": "Zod validation schema"
    }
  ]
}
```

**Tips for writing custom boundaries:**
- `glob` uses standard glob patterns — `**` for recursive, `*` for any filename
- `symbolPattern` is a regex matched against each line — use `export` prefix to catch only public symbols
- `kind` can be anything — it becomes the node type in the graph
- After adding, re-run `kk init` and check if new node kinds appear in `nodes_by_kind`

### Step 4: Fix workspace adapter assignments

Check if workspace packages are scanning with the right adapters:

```json
{
  "workspaces": {
    "packages/db": { "adapters": ["drizzle", "generic"] },
    "packages/auth": { "adapters": ["generic"] },
    "packages/types": { "adapters": ["generic"] },
    ".": { "adapters": ["nextjs", "drizzle", "triggerdev", "generic"] }
  }
}
```

**Rule of thumb:** A workspace should only use adapters for frameworks it actually contains. Don't run the Next.js adapter on a utility package.

### Step 5: Verify with queries

After improving config, test the graph quality:

```bash
# Pick a well-known function and trace its impact
kk graph query impact --feature __global__ --symbol createContract --depth 4 --db-path .kodeklarity/index/graph.sqlite --json

# Verify the chain makes sense:
# createContract (server action)
#   → revalidates /contracts page
#   → calls syncContractToSubscription (service)  
#   → uses contracts table
#   → uses subscriptions table

# Pick a table and check what depends on it
kk graph query upstream --feature __global__ --symbol contracts --depth 3 --db-path .kodeklarity/index/graph.sqlite --json

# Should show: which server actions, services, and pages ultimately depend on this table
```

**If a connection is missing:**
1. Check if both endpoints are in the graph (both should appear as nodes)
2. If a node is missing, add a `customBoundary` for its layer
3. If both nodes exist but no edge, the import chain may not be resolved — check if the import uses an alias that kk doesn't know about and add it to `importAliases`
4. Re-run `kk init`

### Step 6: Handle gaps

The `gaps` in `kk init` output show files with patterns kk couldn't statically resolve:

```json
{
  "gaps": [
    {
      "file": "src/router/dispatch.ts",
      "lines": "45",
      "reason": "dynamic_dispatch",
      "hint": "Contains dynamic dispatch pattern — agent should review to resolve targets"
    }
  ]
}
```

For each gap:
1. Read the flagged file and lines
2. Understand what the dynamic pattern does
3. If you can determine the targets, add edges via `customBoundaries` or note them for future `kk add-edge` support

### Step 7: Iterate

The graph improves each time you:
1. Add a `customBoundary` for a missing architectural layer
2. Fix a workspace adapter assignment
3. Add an import alias kk doesn't know about
4. Increase trace depth for deeply nested call chains

**The config is cumulative** — your improvements persist across sessions. Other agents and developers benefit from your config improvements.

### Example: Improving a Next.js + Drizzle monorepo

Starting graph: 530 nodes (routes, actions, tables, jobs) — good but missing service/query layers

Agent investigates:
```
Read src/lib/actions/contracts.ts
  → imports from src/lib/services/contract-subscription-sync.ts (service layer!)
  → imports from src/lib/queries/contracts.ts (query layer!)
  → imports from @sastrify/db/schema (tables)
```

Agent adds to config:
```json
{
  "customBoundaries": [
    { "name": "query-layer", "kind": "query", "glob": "src/lib/queries/*.ts", "symbolPattern": "export (async )?function", "reason": "Query layer" },
    { "name": "services", "kind": "service", "glob": "src/lib/services/*.ts", "symbolPattern": "export (async )?function", "reason": "Service layer" }
  ]
}
```

Result: 530 → 752 nodes, 27,953 → 43,767 edges. Service and query layers now visible in the graph. Impact queries now show full chains: action → service → query → table.

## What `kk` Detects Automatically

| Framework | What it finds |
|-----------|--------------|
| **Next.js** | Pages (`app/**/page.tsx`), API routes (`app/**/route.ts`), server actions (`'use server'`), middleware, layouts, `revalidatePath`/`revalidateTag` connections |
| **Drizzle** | Table definitions (`pgTable`, `sqliteTable`), RLS policies (`.policy()`), `db.select/insert/update/delete` → table edges, `relations()` |
| **NestJS** | Controllers (`@Controller`), services (`@Injectable`), modules (`@Module`), guards, interceptors, route handlers |
| **Express** | Routes (`router.get/post/...`), middleware (`app.use`) |
| **React** | Custom hooks (`use*`), context providers (`createContext`) |
| **Trigger.dev** | Tasks (`task()`), jobs (`defineJob()`) |
| **Generic** | External API calls (`fetch('https://...')`), event emissions (`.emit()`, `.publish()`), dynamic dispatch patterns (flagged as gaps) |

## What `kk` Does NOT Detect (Agent Should Fill)

- Dynamic dispatch (`handlers[action]()`) — flagged as gaps
- Runtime dependency injection beyond NestJS decorators
- Database queries through ORMs other than Drizzle
- Inter-service communication via HTTP/gRPC (shows as `external_api` leaf nodes)
- Config-driven routing or feature flags
- Reflection, `eval`, computed property access

When you see these patterns, add appropriate `customBoundaries` to config or note them in the gaps for future improvement.

## Files

```
.kodeklarity/
├── config.json            ← agent-editable project config
└── index/
    └── graph.sqlite       ← the code graph database
```

Both files are gitignored by default. The config can be committed if the team wants to share graph configuration.
