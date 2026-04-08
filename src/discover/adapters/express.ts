import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

export const expressAdapter: FrameworkAdapter = {
  name: "express",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "express");
    if (!version) return null;
    // Don't detect if Next.js is present (Next.js has its own routing)
    if (getDepVersion(packageJson, "next")) return null;
    return { name: "Express", version, adapter: "express" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    const tsFiles = await findFiles(wsRoot, ["**/*.ts", "**/*.js"]);
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = toRelative(file, repoRoot);

      // Find route definitions: router.get('/path', ...) or app.post('/path', ...)
      const routeMatches = [
        ...content.matchAll(/(?:router|app)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]/g),
      ];

      for (const rm of routeMatches) {
        const method = rm[1].toUpperCase();
        const routePath = rm[2];
        const line = findLineNumber(content, rm[0]);

        if (method === "USE") {
          // Middleware
          nodes.push({
            id: makeNodeId("middleware", rel, routePath),
            kind: "middleware",
            symbol: `USE ${routePath}`,
            file: rel,
            line,
            reason: `Express middleware: ${routePath}`,
            adapter: "express",
            metadata: { routePath, framework: "express" },
          });
        } else {
          nodes.push({
            id: makeNodeId("api_route", rel, `${method}:${routePath}`),
            kind: "api_route",
            symbol: `${method} ${routePath}`,
            file: rel,
            line,
            reason: `Express route: ${method} ${routePath}`,
            adapter: "express",
            metadata: { httpMethod: method, routePath, framework: "express" },
          });
        }
      }
    }

    return { adapter: "express", nodes, edges };
  },
};
