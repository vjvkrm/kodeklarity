# Feature Requests & Research

Planned features and research for KodeKlarity. Items are organized by area, with research notes where available.

---

## Visualization Layer

### Terminal Tree View (Layer 1)

Render BFS traversal as a structured tree in terminal using chalk for color coding:

```
Risk: MEDIUM (62/100)  |  3 files changed  |  12 nodes affected

Changed:
  src/api/users.ts → UserController.update

Impact chain:
  UserController.update
  ├── [calls] → UserService.validateAndUpdate    (high)
  │   ├── [uses_table] → users                   (high)  ⚠ DB write
  │   └── [calls] → NotificationService.send     (medium)
  │       └── [calls_external] → EmailProvider    (low)
  ├── [imports] → UserValidator                   (high)
  └── [calls] → AuditLogger.log                  (high)  ⚠ Side effect
```

- Reuses existing BFS traversal from `src/query.js`
- Color coding: red (high risk), yellow (medium), green (low)
- Warning badges on side-effect nodes (DB writes, external APIs, events)
- Priority: HIGH — highest value/effort ratio

### Mermaid Output (Layer 2)

Generate Mermaid flowcharts from traversal data via `--mermaid` flag on `kk risk` / `kk impact`.

- Cap at depth-2 (~20 nodes max) for readability
- Works in GitHub PR descriptions, markdown renderers
- Mermaid is a complement, not the primary viz — no interaction, unreadable past ~30 nodes
- Priority: MEDIUM

### Interactive Browser View (Layer 3)

`kk viz` command that spins up a local web server with an interactive graph.

**Stack:**

| Component | Library | Why |
|-----------|---------|-----|
| Rendering | React Flow (xyflow) | Custom node components, built-in zoom/pan/minimap, React-native |
| Layout | ELK.js (layered/Sugiyama) | Best for DAGs, supports node grouping by directory |
| Impact view | Custom radial layout (~30 LOC) | Changed node at center, concentric rings by depth = "ripple" metaphor |
| Data model | Graphology | Shared between views, rich graph algorithm library |

**Change-impact view design:**

1. Progressive disclosure — 3 levels:
   - Summary card: "3 files changed, 12 nodes affected, 2 high-risk paths. Risk: Medium." No graph.
   - Compact graph: Changed nodes + depth 1-2 downstream only (5-20 nodes).
   - Full graph: All downstream to max depth. Only on explicit drill-down.

2. Visual encoding:
   - Changed nodes: orange/red fill, placed at center/left
   - Depth 1: amber, Depth 2: yellow, Depth 3+: light gray
   - Edge confidence: solid (high), dashed (medium), dotted (low)
   - Warning badges on side-effect nodes (DB writes, external APIs, events)
   - Nodes shaped/colored by kind (route, table, service, hook, etc.)

3. Clustering by directory — group nodes into bordered regions. Engineer sees "5 clusters" not "50 nodes."

4. Semantic zoom — zoomed out shows colored dots, mid-zoom shows kind+name, zoomed in shows file/line/confidence/metadata.

**Priority: LOW** — build after terminal tree and mermaid are solid.

### Research Notes

**Cognitive load findings:**
- Graphs become cognitively useless past ~50-100 nodes (Yoghourdjian et al., 2020 — measured via EEG, pupil dilation)
- 80% of visualization research uses 100 nodes or fewer
- ASCII graphs in terminal are unreadable past ~15 nodes; structured tree is strictly better

**Layout decisions:**
- Never use force-directed layout for code graphs — code has direction, force layout hides it
- ELK layered (Sugiyama) is the best fit for DAGs with clear flow direction
- Radial layout is the most intuitive "ripple effect" metaphor for impact visualization

**Library decisions:**
- React Flow over Cytoscape.js: custom React node components, declarative API
- React Flow over D3-force: too low-level, weeks of boilerplate
- React Flow over Sigma.js: Sigma is for 10k+ nodes (WebGL), overkill at 50-500
- ELK.js over Dagre: more configurable, supports partitioning, similar bundle size
- Graphology as shared data model works with both React Flow and Sigma.js if we ever need the latter

**References:**
- Scalability of Network Visualisation from a Cognitive Load Perspective (arxiv.org/abs/2008.07944)
- React Flow ELK.js example (reactflow.dev/examples/layout/elkjs)
- Animated Exploration of Graphs with Radial Layout (UC Berkeley)
- CodeScene change coupling visualization approach

---

## kk_review — Pre-Commit Impact Analysis

### Problem

KK only sees committed code. Writing new files means KK is blind to them.
Committing just so KK can see is a bad commit. AI reviewers catch bugs but miss architecture gaps.
Nobody tells you "your new service isn't connected to anything yet" or "you write to 6 tables but forgot RLS on 2 paths."

### What it does

Reads working tree diff (uncommitted). Builds a temp in-memory graph.
Shows what's new, what changed, what's broken, what's orphaned.
No commit needed. Just run.

### Input

```
kk_review [--base=HEAD]
```

Reads `git diff` + untracked files. Parses them. Merges with existing committed graph. Outputs report.

### Output

```
new_symbols — what I added
  importOrgUsers (service) — services/import-users.ts
  importSubscription (service) — services/import-subscription.ts
  matchSubscriptionEntities (service) — matching/entity-matcher.ts

new_edges — what calls what
  importSubscription → matchSubscriptionEntities (calls)
  importSubscription → subscription_products (writes)
  importOrgUsers → member_roles (writes)
  importOrgUsers → ensureDefaultRoles (calls, from @sastrify/auth)

orphans — new code nobody calls yet
  ⚠ importOrgUsers — not called from any existing code path
  ⚠ importSubscription — not called from any existing code path
  → wire into legacyCompanyImportJob?

tables_touched — what DB this change hits
  WRITES: users, members, member_roles, subscriptions, subscription_products,
          publishers, products, suppliers, subscription_stakeholders
  READS:  publishers, products, suppliers, roles, users, members

breaking_changes — did I change something existing code depends on
  legacy-client.ts modified — 5 new exports added (non-breaking)
  users.ts mapper modified — return type changed (check callers)

missing_coverage — stuff I probably forgot
  ? new services have 0 test files
  ? matching/ folder not in kk customBoundaries config
```

### When to use

- Before commit: "is my code connected right?"
- Before PR: "what's my blast radius?"
- During review: reviewer runs `kk_review` on PR branch
- After merge: normal `kk impact` takes over (committed graph)

### Why not just use kk_impact after commit?

Because the bad commit exists then. You want to know BEFORE.
Also orphan detection only works on diff — after commit everything looks "normal" but the service nobody calls is still an orphan.

### Implementation approach

1. `git diff --name-only HEAD` + `git ls-files --others --exclude-standard` = changed files
2. Parse only those files (same parser as `kk rebuild`)
3. Merge parsed nodes/edges into existing graph (in-memory, don't persist)
4. Run orphan detection: new nodes with 0 incoming edges from existing graph
5. Run table-touch analysis: grep insert/update/delete/select on schema symbols
6. Output JSON or markdown

### Origin

This captures exactly what we hit on 2026-04-16 — built 4 services, KK couldn't see them, couldn't tell us they're orphans or what they touch. The subagent caught code bugs but missed the architecture gaps.

**Priority: HIGH** — solves a real daily pain point.
