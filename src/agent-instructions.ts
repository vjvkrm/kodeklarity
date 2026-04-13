import fs from "node:fs/promises";
import path from "node:path";

const INSTRUCTIONS_FILE = ".kodeklarity/AGENT.md";

const AGENT_INSTRUCTIONS = `# KodeKlarity — you build it and you use it

This project has a living code graph + memory layer via \`kk\` (MCP server: \`kodeklarity\`).
**You are expected to both USE it and IMPROVE it as you work.**

---

## Use it — before every code change

| Call | Why |
|------|-----|
| \`kk_impact <symbol>\` | See downstream blast radius. **Read the \`memories\` field** — past agents flagged things you need to know. |
| \`kk_upstream <symbol>\` | Find all callers before changing a shared function |
| \`kk_side_effects <symbol>\` | See reachable DB writes, API calls, jobs |
| \`kk_risk\` | Before committing — 0–100 risk score for your diff |

Pass the **symbol name** (\`updateUser\`, \`users\`) — kk resolves it like \`kk impact\` does.

---

## Build it — add boundaries when the graph is missing a layer

If \`kk_impact\` shows an obvious code call but no graph edge (e.g. a server
action that clearly calls service functions but no service nodes appear),
**the graph doesn't know about a boundary** in this project.

Boundaries are what kk tracks as nodes. Framework boundaries (routes, tables,
jobs) are detected automatically. Project-specific layers (services, queries,
repositories, validators) need to be registered.

**Add a boundary rule** — not a single node. The rule creates a boundary node
for every matching symbol in the layer (usually dozens at once, permanently).

1. Read \`.kodeklarity/config.json\`
2. Add a \`customBoundary\` entry for the layer
3. Run \`kk_rebuild --force\`

\`\`\`json
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
\`\`\`

Do NOT write a memory saying "a layer is missing" — add the boundary.
Do NOT write a glob that matches only one function — match the layer it lives in.

---

## Write memory — capture what you learn (selectively)

Memory costs tokens every future session — so the bar is high.

### The three-gate test

Only write a memory if ALL three are true:

1. **Non-obvious** — a fresh agent reading the code alone would miss this
2. **Durable** — still true next month, not "I'm mid-refactor right now"
3. **Actionable** — the next agent will do something different because of it

If any gate fails, don't write. The git commit message is enough.

### Search first to avoid duplicates

Run \`kk_memory_search "<keyword>"\` before writing. If a similar memory exists,
use \`kk_memory_update\` instead of creating another one.

### Node-level memories (attached to a symbol)

Categories: \`gotcha\` (watch out) · \`decision\` (why it's done this way) · \`warning\` (fragile/dangerous)

Worth writing:
- Hidden DB constraints invisible in schema (partial indexes, RLS, triggers, cascades)
- Ordering that matters (\"X must run before Y because Z\")
- Intentional-looking-like-a-bug (\"this early return is load-bearing — removing breaks prod\")
- Known fragility with context (\"external API returns null on weekends, handled by retry\")

Format: **ONE line, 80–150 chars**. Always include \`summary\` (shorter, drives FTS search).

**Good:** \`\"Stripe sync must complete before DB write — reconcileStripeState fixes desync\"\`
**Bad:**  \`\"Updated updateSubscription to handle billing correctly\"\` (vague, obvious, commit-msg material)

### Global / feature-level memories (category \`wiki\`, no \`symbol\`)

**Extremely rare.** These are returned on every matching query, so every wiki memory
taxes every future session. Only write if the convention:
- Applies to 10+ nodes across the repo (truly cross-cutting)
- Isn't discoverable from package.json, README, or CLAUDE.md
- Would be violated by a new agent's default behavior

Worth writing:
- \"Migrations must be backwards-compatible — zero-downtime deploys\"
- \"Soft-delete only — never \\\`DELETE FROM\\\`\"

NOT worth writing (delete if you see these):
- \"This project uses Next.js\" (package.json shows this)
- \"Follow team style guide\" (vague, no action)
- \"Code is in TypeScript\" (obvious)

---

## Examples

Good memory:
\`\`\`
kk_memory_write
  symbol: updateSubscription
  content: \"Must sync Stripe before DB write — reconcileStripeState fixes desync\"
  summary: \"Stripe sync order matters\"
  category: gotcha
\`\`\`

Updating instead of duplicating:
\`\`\`
1. kk_memory_search \"stripe\"
2. Found mem-abc123 — close but out of date
3. kk_memory_update mem-abc123 with sharper content
\`\`\`

---

## Comparing with/without kk

If the user asks whether kk helps, use the \`kk_compare\` MCP tool to run a live
side-by-side comparison on this project.

## Reporting bugs

If a query returns wrong results (0 when data exists, or clearly too many), check existing issues:
\`\`\`
gh search issues --repo vjvkrm/kodeklarity \"<short description>\"
\`\`\`
If no match, file a new issue with graph context from \`kk_status\`.
`;

/**
 * Write agent instructions to the project's .kodeklarity/ directory.
 * Only writes on first run (doesn't overwrite if already exists).
 */
export async function writeAgentInstructions(repoRoot: string): Promise<string | null> {
  const filePath = path.join(repoRoot, INSTRUCTIONS_FILE);

  // Don't overwrite existing instructions (user/agent may have customized)
  try {
    await fs.access(filePath);
    return null; // Already exists
  } catch {
    // Doesn't exist — create it
  }

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, AGENT_INSTRUCTIONS, "utf8");
  return filePath;
}

