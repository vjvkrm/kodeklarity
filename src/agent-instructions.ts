import fs from "node:fs/promises";
import path from "node:path";

const INSTRUCTIONS_FILE = ".kodeklarity/AGENT.md";

const AGENT_INSTRUCTIONS = `# KodeKlarity (\`kk\`) — use it, improve it

Graph + memory layer. CLI or MCP (identical). Installed as devDependency (\`kodeklarity\`).

**When starting work or after pulling new code:**
- \`kk_rebuild\` — update the graph to match current code
- \`kk_impact <symbol>\` / \`kk_upstream <symbol>\` / \`kk_side_effects <symbol>\` — understand what you're about to touch (read the \`memories\` field!)
- If \`kk_impact\` shows missing connections (e.g., server action calls a service but no service nodes appear), add a \`customBoundary\` rule in \`.kodeklarity/config.json\` matching the whole layer (not one symbol), then \`kk_rebuild --force\`
- \`kk_risk\` on your diff — if >70, explain affected systems before proceeding

**Before every commit (mandatory):**
- \`kk_precommit\` — catches orphaned services, unwired code paths, missing table access, breaking changes, and missing tests. Fix all issues it reports before committing. If \`orphans\` are intentional (e.g., new service not wired yet), explain in the commit message.

**Memory discipline:**
- When you change a function's behavior, check \`kk_memory_read <symbol>\` — if there's a stale memory, update or remove it via \`kk_memory_update\`.
- When you make a non-obvious decision (why X, not Y), write a memory: \`kk_memory_write\` with category \`decision\` or \`gotcha\`.
- Write only if all three hold: (1) non-obvious from code, (2) durable (true next month), (3) actionable (next agent behaves differently).
- Search first (\`kk_memory_search\`); prefer \`kk_memory_update\` over duplicates.
- Categories: \`gotcha\`, \`decision\`, \`warning\`, \`wiki\` (rare). Worth writing: hidden DB constraints, load-bearing ordering, intentional-looking-like-bug. Not worth: "fixed X", restating code.
- Remove stale memories — if a memory references a deleted function or changed behavior, delete it. Code and memory must stay consistent.

**Full reference:** See https://github.com/vjvkrm/kodeklarity/blob/main/AGENT.md for all commands, config options, graph model, memory system details, and first-run playbook.
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

