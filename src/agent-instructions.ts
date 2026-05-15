import fs from "node:fs/promises";
import path from "node:path";

const INSTRUCTIONS_FILE = ".kodeklarity/AGENTS.md";

const AGENT_INSTRUCTIONS = `# kk — for AI coding agents

kk is a graph + memory layer for this codebase. The graph is in \`.kodeklarity/index/graph.sqlite\`. Memories anchor to graph nodes (function/route/table symbols) and survive refactors via a re-anchor pass on every rebuild.

Use kk via the MCP tools (\`kk_*\`) or the CLI (\`kk ...\`) — same shape, same output.

## When kk helps most

- **Before changing a symbol with many callers** → \`kk_impact <symbol>\` shows downstream callers and any \`memories\` already anchored to that symbol.
- **Before claiming done** → \`kk_precommit\` returns \`breaking_changes\`, \`orphans\`, \`tables_touched\`, \`coverage_action\`, and any \`memories\` attached to touched nodes. Read each field; act on non-empty ones.
- **Reviewing a branch / PR** → \`kk_review --base main\` covers everything since the branch diverged.
- **Finding callers / paths** → \`kk_upstream <symbol>\`, \`kk_why --from A --to B\`. Faster and more accurate than grep for symbol-level questions.
- **Recalling prior context** → memories surface automatically in \`kk_impact\` / \`kk_precommit\` output. Read them.

## When to write memory

Write a memory anchored to a symbol when ANY of these are true and the info isn't visible from reading the code:

- **Bug fix where the cause wasn't obvious** → category \`gotcha\`
- **Choice between approaches that's not documented elsewhere** → category \`decision\`
- **Code where one wrong line breaks production** → category \`warning\`
- **External constraint** (rate limit, deadline, undocumented API behavior) → category \`context\`
- **Cross-project knowledge not tied to a symbol** → category \`wiki\` (rare; use without \`--symbol\`)

Don't write memory for: things obvious from the code, your own actions ("I edited X"), or every tool call. Few, high-signal entries.

Always anchor with \`symbol\` (CLI: \`--node <symbol>\`). Anchored memories survive refactors; unanchored don't.

If \`kk_memory_list_stale\` returns entries, the symbol they were anchored to was renamed or deleted. Repair via \`kk_memory_update\` or remove with \`kk_memory_delete\`.

## Configuration

If \`kk_precommit\` reports \`coverage_action\` (files with no boundary nodes), decide each: add a \`customBoundary\` to \`.kodeklarity/config.json\` (real boundary), or add to \`ignoreCoverage\` (entry point / dispatch / types). Then \`kk_init --force\` and re-run.

Full reference: https://github.com/vjvkrm/kodeklarity
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

  // Migrate from the legacy singular filename if it's the only one present.
  // Previous kk versions (<= v0.3.x) wrote .kodeklarity/AGENT.md. We rename
  // it to AGENTS.md (plural — community convention as of 2026) rather than
  // creating a second file, so the user keeps any customizations they made.
  const legacyPath = path.join(repoRoot, ".kodeklarity", "AGENT.md");
  try {
    await fs.access(legacyPath);
    // Legacy exists, new doesn't (we returned null above if it did).
    await fs.rename(legacyPath, filePath);
    return filePath;
  } catch {
    // No legacy file — fall through and write a fresh template.
  }

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, AGENT_INSTRUCTIONS, "utf8");
  return filePath;
}

