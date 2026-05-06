<div align="center">

# KodeKlarity

### The visibility layer for AI-coded changes.

*Stop guessing what your AI agent just broke — see every ripple, locally and instantly.*

[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white)](#)
[![MCP](https://img.shields.io/badge/MCP-native-8B5CF6)](#)
[![Zero LLM](https://img.shields.io/badge/Zero_LLM-pure_static_analysis-22C55E)](#)
[![Local only](https://img.shields.io/badge/Local-no_telemetry-0EA5E9)](#)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-yellow.svg)](./LICENSE)

</div>

<br>

![KodeKlarity dashboard — graph view, diff inspector, agent coverage callout](docs/dashboard.png)

```bash
npm install -g kodeklarity
cd your-project && kk init        # build the graph (5s, zero LLM cost)
kk dashboard                       # open the visibility layer
```

<br>

---

## The visibility gap

Your AI agent edits five files. Tests pass. You commit.

What you didn't see: the background job that reads the same table, the three pages revalidating from that service, the API route serving the same data to mobile, the 145 callers downstream of the function it tweaked.

Your agent isn't lazy — it's *fast*, and you can't see fast enough. `grep` finds text. KodeKlarity finds **structural connections** — and shows you which ones your agent just touched.

<br>

---

## What you actually see

Two views, one engine. Both work from your live `git diff` — no extra setup per change.

### Precommit — the closed set

> *Exactly what you changed. Nothing more.*

The functions, routes, services, tables, and edges introduced or modified by your current diff. No callers, no callees, no ambient context. Use it to sanity-check: *am I touching what I think I'm touching?*

### Impact — the ripple

> *Changed nodes + everything one hop away.*

Same change set, expanded by a 1-hop ring of callers and callees. Use it before you commit: *what could break?* The dashboard renders this as a focused subgraph; click any node to see its diff and metadata.

<br>

---

## Built for AI agents — via the CLI they already have

Every coding agent has a Bash tool. That's all KodeKlarity needs.

No plugin to install per editor. No MCP server to configure. No agent-specific glue. **Every kk command takes `--json`** — output is structured, deterministic, sub-second, and works identically in Claude Code, Cursor, Codex, Cline, Windsurf, Aider, or anything else that can shell out.

Three modes the agent operates in:

**During work — exploratory lookups:**

```bash
kk impact updateUser --json --depth 2     # what breaks if I change this?
kk upstream requireAuth --json            # what calls this?
kk side-effects createOrder --json        # what writes/triggers/emits?
kk why --from createOrder --to users --json   # how are these connected?
```

**Before commit — the workflow gate (uncommitted changes):**

```bash
$ kk precommit --json
{
  "status": "ok",
  "changed_files": ["src/billing/refunds.ts", "src/jobs/email-queue.ts"],
  "new_symbols":   [...],
  "new_edges":     [...],
  "breaking_changes": [...],
  "tables_touched": { "writes": ["payments"], "reads": ["users", "orders"] },
  "orphans":       [],
  "missing_coverage": [...],
  "coverage_action": { ... },
  "memories":      [...],
  "stats":         { ... }
}
```

**Branch / PR review — the full diff since branch was created:**

```bash
$ kk review --base main --json
{
  "status": "ok",
  "diff_window": {
    "base_ref": "main",
    "merge_base": "bf02eec",
    "commits_on_branch": 3
  },
  "changed_files": [...],         # everything since merge-base, committed + uncommitted
  "new_symbols":   [...],
  "new_edges":     [...],
  "breaking_changes": [
    {
      "symbol": "updateUser",
      "kind": "action",
      "downstream_count": 12,
      "verdict": "signature_changed",   # ← AST-level: callers may break
      "note": "signature changed — 12 downstream dependents (callers may break)"
    }
  ],
  "tables_touched": { ... },
  "orphans":       [...],
  "missing_coverage": [...],
  "coverage_action": { ... },
  "memories":      [...],
  "stats":         { ... }
}
```

`kk precommit` is the *uncommitted-only* gate — what's in your working tree right now. `kk review --base <ref>` is the *branch-level* report — everything since the branch diverged, including commits already made. Both return the same field shape so the agent's parsing logic is identical.

**No risk score, no synthetic numbers — the structural fields *are* the risk signals.** Agents read `breaking_changes`, `tables_touched.writes`, `orphans`, and `coverage_action` directly. Each `breaking_changes` entry includes an AST-level `verdict` (`signature_changed`, `removed_or_renamed`, `body_changed`) so the agent prioritizes — declarations that are textually unchanged are silently dropped from the report (no file-granular noise).

<br>

### The agent loop (the part nobody else has)

KodeKlarity isn't just a dashboard for you — it's a **machine-readable contract for your agent**.

When `kk precommit --json` finds files in your diff that don't have boundary nodes yet, the response includes a structured `coverage_action`:

```json
{
  "files": ["src/billing/refunds.ts", "src/jobs/email-queue.ts"],
  "next_steps": [
    "Add a customBoundary to .kodeklarity/config.json (real boundary)",
    "Or add the path to ignoreCoverage (entry/types/dispatch — not a boundary)",
    "Run kk init --force",
    "Re-run kk precommit until clean"
  ],
  "example_boundary": {
    "name": "my_boundary",
    "kind": "service",
    "glob": "src/billing/**/*.ts",
    "symbolPattern": "^export\\s+(async\\s+)?function\\s+",
    "reason": "Describe what this group of files does"
  }
}
```

Your agent reads this, edits `.kodeklarity/config.json`, runs `kk init --force`, and the graph permanently improves. **The graph self-corrects through the agent that uses it.** No manual configuration, no human in the loop.

<br>

---

## The CLI

The full command surface — every command takes `--json` for agent consumption:

```bash
kk init                          # build the graph (5s, zero LLM cost)
kk rebuild                       # incremental update from git diff
kk precommit                     # uncommitted changes only — pre-commit gate
kk review --base main            # branch-level review — committed + uncommitted vs main
kk impact updateUser --depth 2   # what breaks if I change this symbol?
kk upstream requireAuth          # what calls this?
kk downstream createOrder        # what does this call?
kk side-effects createOrder      # what writes/triggers/emits?
kk why --from createOrder --to users   # how are these connected?
kk status                        # graph overview
kk search billing                # find nodes by name
kk memory write "..."            # agent-written notes attached to nodes
kk dashboard                     # open the visibility layer in a browser
```

Telling your agent to run `kk precommit --json` before claiming done is a one-line addition to its rules file. Or paste the auto-generated `.kodeklarity/AGENT.md` reference into your agent's system prompt — that file ships pre-loaded with the workflow.

<br>

---

## Dashboard (for humans)

```bash
kk dashboard
```

Local web UI on `http://127.0.0.1:4421`. Two-pane layout (graph + diff), resizable inspector, search-and-filter, light/dark theme, keyboard shortcuts (`R` refresh, `1`/`2` switch views, `/` search, `?` help). Same data the CLI returns — rendered for clicking. Bound to localhost only, no telemetry, no remote calls.

<br>

---

## MCP (optional)

If your agent natively supports MCP (Claude Code, Cursor, Cline, Windsurf, etc.), KodeKlarity ships an MCP server — `kk-mcp` — that exposes the same commands as first-class tools (`kk_precommit`, `kk_impact`, `kk_rebuild`, `kk_memory_*`).

It's strictly nicer than the Bash-call path: no shell escaping, structured arguments, native tool-call telemetry in the agent UI. But it's **opt-in** — the CLI is the universal path and works without any of this.

```jsonc
// e.g. ~/.claude/mcp.json
{
  "mcpServers": {
    "kodeklarity": { "command": "kk-mcp" }
  }
}
```

<br>

---

## Get started

```bash
# 1. Install
npm install -g kodeklarity

# 2. Build the graph for your project (5s, zero LLM cost)
cd your-project
kk init
```

That's the whole setup.

**Tell your agent to use it** — paste a `@.kodeklarity/AGENT.md` reference into your agent's rules / system prompt. That file is auto-generated by `kk init` and tells the agent the workflow: use `kk impact / upstream / side-effects` to reason about what it's touching, run `kk precommit --json` before claiming done, decide on any `coverage_action` issues, write memories on non-obvious decisions. All commands take `--json`.

**Want the visual?** Run `kk dashboard` whenever you want to click through what the agent's been doing.

**Want native MCP tool calls?** Point your agent at `kk-mcp` (see MCP section above).

<br>

---

## What it catches

Every `kk precommit --json` and `kk review --base <ref> --json` returns the same structured report:

| Signal | What it means |
|---|---|
| `new_symbols` | Functions, routes, services your diff introduces |
| `new_edges` | Calls / imports / writes / triggers connecting them |
| `breaking_changes` | Existing nodes whose **declaration actually changed** at the AST level (per-symbol diff against the base ref). Each entry has a `verdict`: `signature_changed` (high signal — callers may break), `removed_or_renamed` (high signal — check callers), `body_changed` (medium — verify behavior). Symbols whose text is unchanged are dropped, so file-level edits don't pollute the report. |
| `tables_touched.writes` / `.reads` | DB tables your changes hit, by direction |
| `orphans` | New code that nothing calls — wired up wrong, or dead |
| `missing_coverage` + `coverage_action` | Diff files with no boundary nodes — agent fixes via customBoundary or ignoreCoverage |
| `memories` | Auto-surfaced agent notes attached to touched nodes |
| `diff_window` (review only) | Merge-base SHA + commit count, so the agent knows what window was analyzed |

Each non-empty field is itself a risk signal — there's no synthetic score. Agents prioritize by reading the structural fields directly. The dashboard renders the same data visually.

<br>

---

## Under the hood

- **Pure static analysis. Zero LLM calls in the core path.** Predictable cost (free), predictable latency (sub-second queries), deterministic output.
- **Symbol-level accuracy.** Uses TypeScript's `ts.createProgram` for type-aware tracing — finds connections `grep` will never see (re-exports, aliased imports, dynamic dispatch flagged explicitly as gaps).
- **AST-level diff for `breaking_changes`.** When you change one function in a 500-line file, kk doesn't flag every other symbol in that file as "modified". For each candidate, kk parses both the merge-base version (`git show <ref>:<file>`) and the working-tree version, normalizes whitespace, and tags each entry with a verdict. Symbols whose declaration is textually unchanged drop out entirely. On real diffs this typically eliminates 80–90% of noise.
- **Local SQLite + FTS5.** Graph and memory live at `.kodeklarity/index/`. Never leaves your machine. No telemetry.
- **Memory survives every rebuild.** Agents write durable notes (`gotcha`, `decision`, `warning`) attached to nodes; rebuilding the graph wipes nodes/edges but the `memories` table is sacred.
- **`customBoundaries` + `ignoreCoverage`.** The two knobs the agent uses to make the graph match how your code is actually laid out — so coverage warnings stay quiet.

<br>

---

## Framework support

**TypeScript ecosystem only (v1).** Each adapter understands framework-specific patterns that generic tools miss.

### Fully supported & tested
| Framework | What it discovers |
|---|---|
| **Next.js** | Pages, API routes, server actions, middleware, layouts, `revalidatePath` / `revalidateTag` edges |
| **Drizzle ORM** | Tables (`pgTable`/`sqliteTable`), RLS policies, `db.select/insert/update/delete`, relations |
| **Trigger.dev** | Tasks, jobs |

### Adapters built, fixtures in progress
NestJS · Express · React (standalone) · generic patterns (`fetch`, event emitters)

### Planned — community contributions welcome
Prisma · tRPC · Hono · Elysia · Supabase · Clerk / Auth.js · GraphQL · Fastify

**Monorepos:** Turborepo, Nx, pnpm workspaces, npm workspaces all supported with cross-workspace import resolution.

<br>

---

## Why agents shape it themselves

KodeKlarity has no human-tuned config out of the box. The way you (or your agent) extend it:

```json
// .kodeklarity/config.json
{
  "customBoundaries": [
    {
      "name": "billing_service",
      "kind": "service",
      "glob": "src/billing/**/*.ts",
      "symbolPattern": "^export\\s+(async\\s+)?function\\s+",
      "reason": "Billing service layer"
    }
  ],
  "ignoreCoverage": [
    "src/cli.js",                 // dispatch table, not a boundary
    "src/types.ts",               // pure types, no runtime
    "src/main.tsx"                // bootstrap entry
  ]
}
```

When `kk precommit` reports `coverage_action`, the agent decides per file: real boundary → `customBoundaries`, intentional non-boundary → `ignoreCoverage`. Run `kk init --force`, re-run, until clean. The graph compounds across sessions because the *agent maintains it*.

<br>

---

## Contributing

New framework adapters are the highest-leverage contribution. Each one is a single TypeScript file (~100–200 lines) that teaches `kk` about a framework's patterns. See `src/discover/adapters/` for examples and `CONTRIBUTING.md` (or open an issue) for the workflow.

<br>

---

## License

AGPL-3.0. Free for personal use, internal company use, and open-source projects. If you build a competing hosted product, talk to us.
