import fs from "node:fs/promises";
import path from "node:path";

const INSTRUCTIONS_FILE = ".kodeklarity/AGENT.md";

const AGENT_INSTRUCTIONS = `# KodeKlarity — Agent Instructions

This project has a code graph built by \`kk\`. Use it to understand impact, trace dependencies, and make safer changes.

## Before making changes

\`\`\`bash
kk rebuild              # ensure graph is current
kk impact <symbol>      # check what breaks if you change this
kk upstream <symbol>    # check what depends on this
\`\`\`

## Before committing

\`\`\`bash
kk risk                 # risk score for your uncommitted changes
\`\`\`

## Available commands

| Command | Use when |
|---------|----------|
| \`kk impact <symbol>\` | About to modify a function — check blast radius |
| \`kk upstream <symbol>\` | Changing a shared function — find all callers |
| \`kk downstream <symbol>\` | Understanding what a function depends on |
| \`kk side-effects <symbol>\` | Need to know what DB/API/events get triggered |
| \`kk why --from X --to Y\` | Understanding how two things connect |
| \`kk risk\` | Before committing — scores risk 0-100 |
| \`kk status\` | Check if graph exists and is current |
| \`kk rebuild\` | After pulling changes or editing config |

## Improving the graph

The graph config is at \`.kodeklarity/config.json\`. If you notice missing connections:

1. Check \`kk status\` — are the relevant node kinds present?
2. If a layer is missing (queries, services, repositories), find where those files live in this project
3. Add a \`customBoundary\` to \`.kodeklarity/config.json\`:
   \`\`\`json
   {
     "customBoundaries": [
       {
         "name": "query-layer",
         "kind": "query",
         "glob": "<path you found>/*.ts",
         "symbolPattern": "export (async )?function",
         "reason": "Data access layer"
       }
     ]
   }
   \`\`\`
4. Run \`kk rebuild --force\` to apply

## Comparing with/without kk

If the user asks whether kk helps, use the \`kk_compare\` MCP tool to run a live side-by-side comparison.

## Reporting bugs

If a query returns wrong results (0 results when data exists, or way too many), check GitHub issues:
\`\`\`bash
gh search issues --repo kodeklarity/kodeklarity "<description>"
\`\`\`
If no match, file a new issue with graph context from \`kk status\`.
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

