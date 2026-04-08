import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

export const reactAdapter: FrameworkAdapter = {
  name: "react",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "react");
    if (!version) return null;
    // Don't add React adapter if Next.js is present (Next.js adapter handles React)
    if (getDepVersion(packageJson, "next")) return null;
    return { name: "React", version, adapter: "react" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    const tsxFiles = await findFiles(wsRoot, ["**/*.tsx", "**/*.jsx", "src/**/*.tsx", "src/**/*.jsx"]);
    const sourceFiles = tsxFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = toRelative(file, repoRoot);

      // Find createContext calls
      const contextMatches = [...content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createContext/g)];
      for (const cm of contextMatches) {
        const name = cm[1];
        const line = findLineNumber(content, cm[0]);
        nodes.push({
          id: makeNodeId("context", rel, name),
          kind: "context",
          symbol: name,
          file: rel,
          line,
          reason: `React context: ${name}`,
          adapter: "react",
          metadata: { framework: "react" },
        });
      }

      // Find custom hooks (exported use* functions)
      const hookMatches = [...content.matchAll(/export\s+(?:(?:async|const)\s+)?(?:function\s+)?(use\w+)/g)];
      for (const hm of hookMatches) {
        const name = hm[1];
        const line = findLineNumber(content, hm[0]);
        nodes.push({
          id: makeNodeId("hook", rel, name),
          kind: "hook",
          symbol: name,
          file: rel,
          line,
          reason: `React hook: ${name}`,
          adapter: "react",
          metadata: { framework: "react" },
        });
      }
    }

    return { adapter: "react", nodes, edges };
  },
};
