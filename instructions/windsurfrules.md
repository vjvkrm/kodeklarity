# Windsurf rules for KodeKlarity
#
# Copy this file to your project as `.windsurfrules`. Modify freely for your project.

## KodeKlarity — you build it and you use it

This project has a living code graph + memory layer via `kk`. **You are expected to both USE it and IMPROVE it as you work.**

- Tools work as **CLI** (`kk impact foo`) or **MCP** (`kk_impact`) — identical behavior. Below uses MCP names; swap to CLI form if MCP isn't configured.

---

### USE — before every code change

- `kk_impact <symbol>` — downstream blast radius. **Read the `memories` field** — past agents flagged things you must respect.
- `kk_upstream <symbol>` — find all callers before changing a shared function.
- `kk_side_effects <symbol>` — reachable DB writes, API calls, jobs.
- `kk_risk` before committing — 0–100 score for your diff.

Pass the **symbol name** (e.g. `updateUser`) — kk resolves it. Don't know the exact name? `kk_search <term>`.

If `kk_risk` is high or score > 70, explain which downstream systems are affected before proceeding.

---

### BUILD — add boundaries when the graph is missing a layer

If `kk_impact` shows an obvious code call but no graph edge, the graph doesn't know about a **boundary** in this project. Framework boundaries are auto-detected; project-specific layers (services, queries, repositories) need registration.

**Add a boundary rule** — not a single node. One rule creates many nodes:

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
Do NOT write a glob that matches only one function — match the *layer*.

---

### WRITE memory — selectively, high bar

Memory costs tokens every future session. Only write if ALL three are true:

1. **Non-obvious** — a fresh agent reading the code alone would miss this
2. **Durable** — still true next month
3. **Actionable** — the next agent will do something different because of it

If any gate fails, don't write.

**Search first** — `kk_memory_search "<keyword>"`. If similar exists, `kk_memory_update`.

**Format:** one line, 80–150 chars. Always include a short `summary`.

Categories: `gotcha` · `decision` · `warning` · `wiki` (global, extremely rare — applies to 10+ nodes repo-wide).

Worth writing: hidden DB constraints, ordering-matters, intentional-looking-like-a-bug, known fragility.
NOT worth writing: commit-message material, re-stating code, trivial observations.

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
- Don't ignore high risk scores — explain why before proceeding.
- Don't manually edit `.kodeklarity/index/graph.sqlite` — use `kk_rebuild`.
