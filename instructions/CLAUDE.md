# Project Instructions

## KodeKlarity — you build it and you use it

This project has a living code graph + memory layer via `kk`. **You are expected to both USE it and IMPROVE it as you work.**

- Graph tools work as **CLI** (`kk impact foo`) or **MCP** (`kk_impact`) — identical behavior. Below uses MCP names; swap to CLI form (`kk impact`, `kk_memory_write` → `kk memory write`, etc.) if MCP isn't configured.

---

### USE — before every code change

- `kk_impact <symbol>` — downstream blast radius. **Read the `memories` field** — past agents flagged things you must respect.
- `kk_upstream <symbol>` — find all callers before changing a shared function.
- `kk_side_effects <symbol>` — reachable DB writes, API calls, jobs.
- `kk_risk` before committing — 0–100 score for your diff. If high or score > 70, explain which downstream systems are affected before proceeding.

Pass the **symbol name** (e.g. `updateUser`, `users`) — kk resolves it. No need to know node_ids.

If you don't know the exact name: `kk_search <term>`.

---

### BUILD — add boundaries when the graph is missing a layer

If `kk_impact` shows an obvious code call but no graph edge (e.g. a server action clearly calls service functions but no service nodes appear), **the graph doesn't know about a boundary** in this project.

Boundaries are what kk tracks as nodes. Framework boundaries (routes, tables, jobs) are detected automatically. Project-specific layers (services, queries, repositories, validators) need to be registered.

**Add a boundary rule** — not a single node. The rule creates a boundary node for every matching symbol (usually dozens at once, permanently).

1. Read `.kodeklarity/config.json`
2. Add a `customBoundary` entry for the layer
3. Run `kk_rebuild --force`

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

**Search first** — `kk_memory_search "<keyword>"`. If a similar memory exists, use `kk_memory_update` instead of creating another one.

**Format:** one line, 80–150 chars. Always include a short `summary` (drives FTS search).

Categories: `gotcha` (watch out) · `decision` (why it's done this way) · `warning` (fragile) · `wiki` (global convention, extremely rare — only if it applies to 10+ nodes repo-wide and isn't discoverable from `package.json` or this file).

Worth writing:
- Hidden DB constraints invisible in schema (partial indexes, RLS, triggers, cascades)
- Ordering that matters ("X must run before Y because Z")
- Intentional-looking-like-a-bug ("this early return is load-bearing — removing breaks prod")
- Known fragility with context ("external API returns null on weekends, handled by retry")

NOT worth writing:
- "Updated X" / "Fixed bug in Y" — commit message material
- Re-stating what the code does — just read the code
- Trivial observations

**Example:**

```
kk_memory_write
  symbol: updateSubscription
  content: "Stripe sync must complete before DB write — reconcileStripeState fixes desync"
  summary: "Stripe sync order matters"
  category: gotcha
```

---

### What NOT to do

- Don't skip `kk_impact` for "small" changes — small changes to shared code have the biggest blast radius.
- Don't ignore high risk scores — if `kk_risk` says high, explain why before proceeding.
- Don't manually edit `.kodeklarity/index/graph.sqlite` — use `kk_rebuild`.
- Don't hand-write new entries directly into the `memories` table — use `kk_memory_write` so FTS indexing stays correct.
