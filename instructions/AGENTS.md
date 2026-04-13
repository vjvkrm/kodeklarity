# Project Instructions for Codex

## KodeKlarity — you build it and you use it

This project has a living code graph + memory layer via `kk`. **You are expected to both USE it and IMPROVE it as you work.**

All commands below use the shell CLI (Codex's default). MCP tool names (`kk_impact`, `kk_memory_write`) work identically if MCP is configured.

---

### USE — before every code change

```bash
kk impact <symbol> --json     # downstream blast radius + surfaced memories
kk upstream <symbol> --json   # all callers (before changing a shared function)
kk side-effects <symbol>      # reachable DB writes, API calls, jobs
kk risk --json                # 0-100 score before committing
```

**Read the `memories` field** in every `kk impact` / `kk upstream` response — past agents flagged gotchas, decisions, and warnings you must respect.

Pass the **symbol name** (e.g. `updateUser`, `users`) — kk resolves it. If you don't know the exact name: `kk search <term>`.

If `kk risk` shows high or score > 70, explain which downstream systems are affected before proceeding.

---

### BUILD — add boundaries when the graph is missing a layer

If `kk impact` shows an obvious code call but no graph edge (e.g. a server action clearly calls service functions but no service nodes appear), **the graph doesn't know about a boundary** in this project.

Boundaries are what kk tracks as nodes. Framework boundaries (routes, tables, jobs) are detected automatically. Project-specific layers (services, queries, repositories, validators) need to be registered.

**Add a boundary rule** — not a single node. The rule creates a boundary node for every matching symbol (usually dozens at once, permanently).

1. Read `.kodeklarity/config.json`
2. Add a `customBoundary` entry for the layer
3. Run `kk rebuild --force`

```json
{
  "customBoundaries": [
    {
      "name": "services",
      "kind": "service",
      "glob": "src/lib/services/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Business logic layer"
    }
  ]
}
```

Do NOT write a memory saying "a layer is missing" — add the boundary.
Do NOT write a glob that matches only one function — match the *layer* it lives in.

---

### WRITE memory — selectively, high bar

Memory costs tokens every future session. Only write if ALL three are true:

1. **Non-obvious** — a fresh agent reading the code alone would miss this
2. **Durable** — still true next month (not "I'm mid-refactor right now")
3. **Actionable** — the next agent will do something different because of it

If any gate fails, don't write. The git commit message is enough.

**Search first:**

```bash
kk memory search "<keyword>"
```

If similar exists, `kk memory update <memory_id>` instead of creating another one.

**Format:** one line, 80–150 chars. Always include `--summary` (drives FTS).

Categories: `gotcha` (watch out) · `decision` (why it's done this way) · `warning` (fragile) · `wiki` (global convention, extremely rare — only if it applies to 10+ nodes repo-wide and isn't discoverable from `package.json` or this file).

Worth writing:
- Hidden DB constraints invisible in schema (partial indexes, RLS, triggers, cascades)
- Ordering that matters ("X must run before Y because Z")
- Intentional-looking-like-a-bug ("this early return is load-bearing — removing breaks prod")
- Known fragility with context ("external API returns null on weekends, handled by retry")

NOT worth writing:
- "Updated X" / "Fixed bug in Y" — commit message material
- Re-stating what the code does
- Trivial observations

**Example:**

```bash
kk memory write "Stripe sync must complete before DB write — reconcileStripeState fixes desync" \
  --node updateSubscription --category gotcha \
  --summary "Stripe sync order matters" --agent codex
```

---

### Rules summary

1. Always run `kk impact` before modifying any shared function, service, or utility.
2. Always run `kk risk` before creating a commit. If risk is "high", include a note about affected downstream systems.
3. Use `--json` for structured output when you need to programmatically check results.
4. If `kk impact` returns 0 for a function that clearly has callers, add a `customBoundary` to `.kodeklarity/config.json` then `kk rebuild --force`.
5. Don't manually edit `.kodeklarity/index/graph.sqlite` or the `memories` table — use the CLI.
