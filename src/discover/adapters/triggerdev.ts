import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

export const triggerdevAdapter: FrameworkAdapter = {
  name: "triggerdev",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "@trigger.dev/sdk");
    if (!version) return null;
    return { name: "Trigger.dev", version, adapter: "triggerdev" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    const tsFiles = await findFiles(wsRoot, ["**/*.ts", "**/*.tsx"]);
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;

      // Skip files that don't reference trigger.dev
      if (!content.includes("@trigger.dev") && !content.includes("task(") && !content.includes("defineJob(")) {
        continue;
      }

      const rel = toRelative(file, repoRoot);

      // Find task() definitions
      const taskMatches = [
        ...content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*task\s*\(\s*\{[^}]*id\s*:\s*['"]([^'"]+)['"]/gs),
      ];

      for (const tm of taskMatches) {
        const varName = tm[1];
        const taskId = tm[2];
        const line = findLineNumber(content, tm[0].split("\n")[0]);

        nodes.push({
          id: makeNodeId("background_job", rel, taskId),
          kind: "background_job",
          symbol: taskId,
          file: rel,
          line,
          reason: `Trigger.dev task: ${taskId}`,
          adapter: "triggerdev",
          metadata: { varName, taskId, framework: "triggerdev" },
        });
      }

      // Find defineJob() definitions (older API)
      const jobMatches = [
        ...content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:client\.)?defineJob\s*\(\s*\{[^}]*id\s*:\s*['"]([^'"]+)['"]/gs),
      ];

      for (const jm of jobMatches) {
        const varName = jm[1];
        const jobId = jm[2];
        const line = findLineNumber(content, jm[0].split("\n")[0]);

        nodes.push({
          id: makeNodeId("background_job", rel, jobId),
          kind: "background_job",
          symbol: jobId,
          file: rel,
          line,
          reason: `Trigger.dev job: ${jobId}`,
          adapter: "triggerdev",
          metadata: { varName, jobId, framework: "triggerdev" },
        });
      }
    }

    return { adapter: "triggerdev", nodes, edges };
  },
};
