# KodeKlarity Agent Guide

You are working with `kk` -- a code graph CLI that maps relationships in TypeScript projects. Use it to understand impact, trace dependencies, and make safer code changes.

## Quick Start

```bash
# First time: scan the project and build the graph
kk init

# Incremental rebuild (after pulling changes or editing config)
kk rebuild

# What breaks if I change this?
kk impact <symbol>

# What depends on this?
kk upstream <symbol>

# What does this call?
kk downstream <symbol>

# Side effects (DB writes, API calls, events)
kk side-effects <symbol>

# How are these connected?
kk why --from <symbol> --to <symbol>

# Risk score for current uncommitted changes (zero-arg)
kk risk

# Graph overview
kk status
```

## Demonstrating Value

If the user asks "does kk actually help?" — call the `kk_compare` MCP tool. It will give you instructions to run a live side-by-side comparison on their codebase.

## First-Run Playbook

Follow this every time you encounter a project where `kk` hasn't been set up, or where `.kodeklarity/config.json` has no `customBoundaries`.

### Step 1: Build the initial graph

```bash
kk init --json
```

Check the output:
- `nodes_by_kind` — what was discovered (routes, server_actions, tables, etc.)
- `edges_by_type` — what connections exist
- `gaps` — files with patterns kk couldn't resolve

### Step 2: Find the project's architectural layers

The initial graph only finds framework-level boundaries (routes, server actions, tables, jobs). Most projects have intermediate layers between these that kk doesn't know about yet.

**Read the project structure to find them:**

```bash
ls src/lib/        # or src/, app/, packages/
ls src/services/   # service layer?
ls src/queries/    # query/repository layer?
ls src/lib/        # common Next.js pattern
```

**Common patterns to look for:**

| What you see | Config `kind` | Typical glob |
|---|---|---|
| `src/lib/queries/*.ts` or `src/queries/*.ts` or `src/repositories/*.ts` | `query` | Whatever path you found |
| `src/lib/services/*.ts` or `src/services/*.ts` | `service` | Whatever path you found |
| `src/lib/validations/*.ts` or `src/schemas/*.ts` | `validator` | Whatever path you found |
| `src/middleware/*.ts` or `src/lib/middleware/*.ts` | `middleware` | Whatever path you found |
| `src/lib/hooks/*.ts` or `src/hooks/*.ts` | `hook` | Whatever path you found |
| `src/lib/utils/*.ts` — SKIP this. Utility files are too generic, they'll add noise. | | |

**The names and paths are different in every project.** Don't assume `src/lib/queries/`. Read the actual directory structure and find where the project puts its data access, business logic, and validation code.

### Step 3: Update config with what you found

Edit `.kodeklarity/config.json` and add `customBoundaries` for each layer you discovered:

```json
{
  "customBoundaries": [
    {
      "name": "query-layer",
      "kind": "query",
      "glob": "<actual path you found>/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Data access / query layer"
    },
    {
      "name": "services",
      "kind": "service",
      "glob": "<actual path you found>/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Business logic layer"
    }
  ]
}
```

### Step 4: Rebuild and verify

```bash
kk rebuild --force
```

Check the new graph:
- Node count should increase (new layers discovered)
- Edge count should increase (new connections through those layers)

### Step 5: Test with a known function

Pick a function you know is important (a server action, an API handler) and test:

```bash
kk impact <function_name> --depth 3
```

**Check the output for quality:**

- **Good sign:** You see connections to services, queries, tables, and pages. The chain makes sense.
- **Bad sign: Missing layers** — you see `server_action → table` but no service or query in between. **Config fix:** Add customBoundaries for the missing layers.
- **Bad sign: Zero connections** — the symbol isn't in the graph. **Config fix:** Check if the file containing it is covered by an adapter or customBoundary. Add one if not.
- **Bad sign: Too many connections** (thousands) — this is likely a code-level issue in kk's tracer, not something config can fix. Report it.

### What config can and can't fix

**Config fixes (agent can solve):**
- Missing nodes (routes, services, queries not showing up) → add `customBoundaries` with correct glob for this project
- Wrong adapters on workspace packages → override `workspaces.[pkg].adapters`
- Imports not resolving → add `importAliases`
- Traversal not deep enough → increase `trace.maxDepth`

**Code bugs in kk (agent can't fix via config):**
- Query returns 0 even though nodes and edges exist in the graph → kk query bug
- Way too many edges (38k+ `uses_table`) → kk tracer bug
- Side-effects returns 0 when impact shows table connections → kk query filter bug

**How to tell the difference:** Run `kk status` to check if nodes and edges exist. If they do, but queries return wrong results, it's a kk bug. If nodes or edges are missing, it's a config issue.

**When you find a kk bug:**

1. Search existing issues first:
   ```bash
   gh search issues --repo kodeklarity/kodeklarity "<short description of the bug>"
   ```

2. If no matching issue exists, file one:
   ```bash
   gh issue create --repo kodeklarity/kodeklarity \
     --title "Bug: <short description>" \
     --body "## What happened
   <describe the problem>

   ## Expected
   <what should have happened>

   ## Steps to reproduce
   1. kk init on a project with <relevant detail>
   2. kk <command> <args>
   3. Got: <actual result>
   4. Expected: <expected result>

   ## Graph context
   - Nodes: <count from kk status>
   - Edges: <count from kk status>
   - Edge types: <relevant types>
   - Node kinds involved: <relevant kinds>

   Filed by AI agent during first-run playbook."
   ```

3. Note the issue in a comment in `.kodeklarity/config.json` or tell the developer, then continue with whatever config fixes you can make.

### Step 6: Test side-effects and upstream

```bash
kk side-effects <function_name> --depth 4
kk upstream <table_name> --depth 2
```

- `side-effects` should show tables, external APIs, events, and background jobs reachable from the function
- `upstream` should show which routes, actions, and services depend on the symbol

If `side-effects` returns 0 for a function that clearly touches the database, the connection chain is missing. Add customBoundaries for the intermediate layer (the query/repository functions that actually call the ORM).

### Step 7: Commit the config (optional)

If the project team wants to share the graph configuration:

```bash
# Remove .kodeklarity/ from .gitignore (or just config.json)
# The graph.sqlite should stay gitignored — it's regenerated by kk init
git add .kodeklarity/config.json
git commit -m "Add KodeKlarity graph config"
```

### Summary of what the agent does on first run

```
1. kk init                          → build initial graph
2. Read project structure            → find intermediate layers
3. Edit .kodeklarity/config.json     → add customBoundaries  
4. kk rebuild --force                → rebuild with new layers
5. kk impact <known_function>        → verify quality
6. kk side-effects <known_function>  → verify depth
7. Fix any issues → repeat 3-6       → iterate until graph is useful
```

This whole process takes 2-3 minutes. After that, `kk rebuild` keeps the graph up to date incrementally.

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
7. Records current git SHA + branch for incremental rebuilds

**When to run:**
- First time opening a project
- After pulling significant changes
- Use `--force` to regenerate config from scratch

**Output (JSON mode):**
- `graph.nodes` / `graph.edges` -- count of discovered items
- `nodes_by_kind` -- breakdown by type (route, server_action, table, etc.)
- `gaps` -- files that need agent review (dynamic dispatch, eval, etc.)
- `boundary_nodes` / `boundary_edges` -- full list of discovered items
- `config_path` -- path to the config file

### `kk rebuild [--force] [--json]`

Incremental rebuild from git diff. Only re-scans changed files and their dependents.

**What it does:**
1. Reads stored git SHA + branch from last build
2. Computes `git diff` to find changed files
3. Re-runs discovery + tracing only for affected files
4. Updates the graph and stores new git SHA
5. Skips entirely if already up-to-date (same SHA)
6. Handles branch switches: detects when you change branches and rebuilds accordingly

**When to run:**
- After pulling changes from remote
- After switching branches
- After editing `.kodeklarity/config.json` (add `--force` to ensure full re-scan)
- Before running queries if you want fresh results

### `kk impact <symbol> [--json]`

Traces downstream blast radius from a symbol. "If I change this, what else is affected?"

**Use when:** About to modify a function, component, or service and need to know the blast radius.

### `kk upstream <symbol> [--json]`

Traces upstream callers. "What depends on this? What calls this?"

**Use when:** Changing a shared function and need to know all callers.

### `kk downstream <symbol> [--json]`

Traces what a symbol calls downstream. "What does this invoke?"

**Use when:** Understanding the full call chain from an entry point.

### `kk side-effects <symbol> [--json]`

Finds reachable side effects (DB writes, external API calls, event emissions).

**Use when:** Need to understand what a change triggers beyond its direct callers.

### `kk why --from <symbol> --to <symbol> [--json]`

Explains the shortest path between two symbols in the graph.

**Use when:** Need to understand how two seemingly unrelated pieces of code are connected.

### `kk risk [--json]`

Zero-arg command. Reads `git diff` of uncommitted changes and computes a risk score (0-100) based on downstream impact, side-effect reach, and graph coverage.

**Use when:** Reviewing a PR or before committing to assess change risk.

### `kk status [--json]`

Shows graph overview: node/edge counts by kind, stack detection results, last build info.

**Use when:** Checking graph health or confirming a rebuild worked.

## MCP Server

KodeKlarity includes an MCP server for direct integration with AI agents.

### Setup (Claude Code)

Add to your MCP config:

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

| Tool | Description |
|------|-------------|
| `kk_init` | Full project scan and graph build |
| `kk_rebuild` | Incremental rebuild from git diff |
| `kk_impact` | Downstream blast radius for a symbol |
| `kk_upstream` | Upstream callers of a symbol |
| `kk_downstream` | What a symbol calls |
| `kk_side_effects` | DB writes, API calls, events from a symbol |
| `kk_why` | Explain connection path between two symbols |
| `kk_risk` | Risk score from current git diff |
| `kk_status` | Graph overview |
| `kk_config` | Read or update config values |

## Git Integration

KodeKlarity tracks git state for efficient rebuilds:

- **SHA tracking:** Each build records the current git commit SHA. `kk rebuild` diffs against this to find changed files.
- **Branch tracking:** Detects branch switches and triggers appropriate rebuilds.
- **Incremental rebuilds:** Only re-processes changed files and their dependents, not the entire project.
- **Skip when clean:** If the stored SHA matches HEAD and there are no working changes, `kk rebuild` skips entirely.
- **Dirty working tree:** `kk risk` reads uncommitted changes directly from `git diff`.

Typical workflow:
```bash
git pull                # fetch changes
kk rebuild              # update graph incrementally
kk risk                 # check risk of your local changes
kk impact <symbol>      # investigate specific change impact
```

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
2. Check `nodes_by_kind` -- are all architectural layers represented?
3. If missing a layer (queries, services, repositories), add a `customBoundary` to config
4. Check `gaps` -- review flagged files and determine if edges need manual addition
5. Run `kk rebuild --force` to pick up config changes
6. Test with `kk impact` on a known symbol -- verify the chain looks right

## Graph Model

- **One graph per repo** -- covers all workspaces in a monorepo
- **Node kinds:** `route`, `api_route`, `server_action`, `layout`, `middleware`, `controller`, `service`, `module`, `guard`, `interceptor`, `table`, `rls_policy`, `background_job`, `external_api`, `event`, `hook`, `context`, `query`, `repository` (custom)
- **Edge types:** `invokes_action`, `calls`, `triggers_job`, `revalidates`, `imports`, `external_call`, `reads_table`, `writes_table`, `uses_table`, `calls_external`, `relates_to`, `invokes_service`, `uses_hook`, `uses_context`, `emits_event`
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
- `nodes_by_kind` -- which architectural layers are represented?
- `edges_by_type` -- are there cross-layer edges (e.g., `uses_table`, `invokes_service`)?
- `gaps` -- which files have patterns kk couldn't resolve?

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
- Does it import from a service layer? Add `customBoundary` for services
- Does it import from a query layer? Add `customBoundary` for queries
- Does it import from a shared package? Verify workspace import resolution is working

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
- `glob` uses standard glob patterns -- `**` for recursive, `*` for any filename
- `symbolPattern` is a regex matched against each line -- use `export` prefix to catch only public symbols
- `kind` can be anything -- it becomes the node type in the graph
- After adding, run `kk rebuild --force` and check if new node kinds appear

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
kk impact createContract

# Verify the chain makes sense:
# createContract (server action)
#   -> revalidates /contracts page
#   -> calls syncContractToSubscription (service)
#   -> uses contracts table
#   -> uses subscriptions table

# Pick a table and check what depends on it
kk upstream contracts

# Should show: which server actions, services, and pages ultimately depend on this table
```

**If a connection is missing:**
1. Check if both endpoints are in the graph (both should appear as nodes)
2. If a node is missing, add a `customBoundary` for its layer
3. If both nodes exist but no edge, the import chain may not be resolved -- check if the import uses an alias that kk doesn't know about and add it to `importAliases`
4. Run `kk rebuild --force`

### Step 6: Handle gaps

The `gaps` in `kk init` output show files with patterns kk couldn't statically resolve:

```json
{
  "gaps": [
    {
      "file": "src/router/dispatch.ts",
      "lines": "45",
      "reason": "dynamic_dispatch",
      "hint": "Contains dynamic dispatch pattern -- agent should review to resolve targets"
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

**The config is cumulative** -- your improvements persist across sessions. Other agents and developers benefit from your config improvements.

### Example: Improving a Next.js + Drizzle monorepo

Starting graph: 530 nodes (routes, actions, tables, jobs) -- good but missing service/query layers

Agent investigates:
```
Read src/lib/actions/contracts.ts
  -> imports from src/lib/services/contract-subscription-sync.ts (service layer!)
  -> imports from src/lib/queries/contracts.ts (query layer!)
  -> imports from @sastrify/db/schema (tables)
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

Agent runs `kk rebuild --force` to pick up config changes.

Result: 530 -> 752 nodes, 27,953 -> 43,767 edges. Service and query layers now visible in the graph. Impact queries now show full chains: action -> service -> query -> table.

## What `kk` Detects Automatically

| Framework | What it finds |
|-----------|--------------|
| **Next.js** | Pages (`app/**/page.tsx`), API routes (`app/**/route.ts`), server actions (`'use server'`), middleware, layouts, `revalidatePath`/`revalidateTag` connections |
| **Drizzle** | Table definitions (`pgTable`, `sqliteTable`), RLS policies (`.policy()`), `db.select/insert/update/delete` to table edges, `relations()` |
| **NestJS** | Controllers (`@Controller`), services (`@Injectable`), modules (`@Module`), guards, interceptors, route handlers |
| **Express** | Routes (`router.get/post/...`), middleware (`app.use`) |
| **React** | Custom hooks (`use*`), context providers (`createContext`) |
| **Trigger.dev** | Tasks (`task()`), jobs (`defineJob()`) |
| **Generic** | External API calls (`fetch('https://...')`), event emissions (`.emit()`, `.publish()`), dynamic dispatch patterns (flagged as gaps) |

## What `kk` Does NOT Detect (Agent Should Fill)

- Dynamic dispatch (`handlers[action]()`) -- flagged as gaps
- Runtime dependency injection beyond NestJS decorators
- Database queries through ORMs other than Drizzle
- Inter-service communication via HTTP/gRPC (shows as `external_api` leaf nodes)
- Config-driven routing or feature flags
- Reflection, `eval`, computed property access

When you see these patterns, add appropriate `customBoundaries` to config or note them in the gaps for future improvement.

## Files

```
.kodeklarity/
├── config.json            <- agent-editable project config
└── index/
    └── graph.sqlite       <- the code graph database
```

Both files are gitignored by default. The config can be committed if the team wants to share graph configuration.
