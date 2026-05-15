import path from "node:path";
import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";
import { parseFile } from "../ast-helpers.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export const nextjsAdapter: FrameworkAdapter = {
  name: "nextjs",
  maturity: "stable",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "next");
    if (!version) return null;
    return { name: "Next.js", version, adapter: "nextjs", maturity: "stable" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    // 1. Pages — app/**/page.{ts,tsx,js,jsx}
    const pageFiles = await findFiles(wsRoot, [
      "app/**/page.ts", "app/**/page.tsx", "app/**/page.js", "app/**/page.jsx",
      "src/app/**/page.ts", "src/app/**/page.tsx", "src/app/**/page.js", "src/app/**/page.jsx",
    ]);
    for (const file of pageFiles) {
      const rel = toRelative(file, repoRoot);
      const routePath = extractRoutePath(file, wsRoot);
      nodes.push({
        id: makeNodeId("route", rel, routePath),
        kind: "route",
        symbol: `Page(${routePath})`,
        file: rel,
        line: 1,
        reason: `Next.js page route: ${routePath}`,
        adapter: "nextjs",
        metadata: { routePath, framework: "nextjs" },
      });
    }

    // 2. API routes — app/**/route.{ts,tsx,js,jsx}
    const routeFiles = await findFiles(wsRoot, [
      "app/**/route.ts", "app/**/route.tsx", "app/**/route.js", "app/**/route.jsx",
      "src/app/**/route.ts", "src/app/**/route.tsx", "src/app/**/route.js", "src/app/**/route.jsx",
    ]);
    for (const file of routeFiles) {
      const rel = toRelative(file, repoRoot);
      const content = await readFileSafe(file);
      if (!content) continue;
      const parsed = parseFile(file, content);
      const routePath = extractRoutePath(file, wsRoot);

      // HTTP handlers are top-level exported functions named GET/POST/PUT/...
      const httpHandlers = parsed.exports.filter(
        (e) =>
          (e.kind === "function" || e.kind === "asyncFunction") &&
          HTTP_METHODS.includes(e.name)
      );
      for (const handler of httpHandlers) {
        nodes.push({
          id: makeNodeId("api_route", rel, `${handler.name}:${routePath}`),
          kind: "api_route",
          symbol: `${handler.name} ${routePath}`,
          file: rel,
          line: handler.line,
          reason: `Next.js API route: ${handler.name} ${routePath}`,
          adapter: "nextjs",
          metadata: { routePath, method: handler.name, framework: "nextjs" },
        });
      }
    }

    // 3. Server actions — file-level `"use server"` directive OR functions with
    //    inline `"use server"` body directive (modern Next 15+ pattern).
    const tsFiles = await findFiles(wsRoot, [
      "**/*.ts", "**/*.tsx",
      "src/**/*.ts", "src/**/*.tsx",
    ]);
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      // Quick reject: skip parsing if file has no chance of being a server action.
      if (!content.includes("use server")) continue;

      const parsed = parseFile(file, content);
      const fileLevelServer = parsed.fileDirectives.includes("use server");

      const rel = toRelative(file, repoRoot);
      const actionExports = parsed.exports.filter((e) => {
        const isFunctionLike =
          e.kind === "function" ||
          e.kind === "asyncFunction" ||
          e.kind === "constArrow" ||
          e.kind === "constAsyncArrow";
        if (!isFunctionLike) return false;
        // Either the whole file is "use server", or the individual function body is.
        return fileLevelServer || e.bodyDirective === "use server";
      });

      for (const action of actionExports) {
        nodes.push({
          id: makeNodeId("server_action", rel, action.name),
          kind: "server_action",
          symbol: action.name,
          file: rel,
          line: action.line,
          reason: `Next.js server action: ${action.name}`,
          adapter: "nextjs",
          metadata: { framework: "nextjs" },
        });
      }

      // revalidatePath calls — emit `revalidates` edges from the containing
      // server action node to a matching page node (if any).
      const revalidateCalls = parsed.findCallsWithStringArg("revalidatePath");
      for (const call of revalidateCalls) {
        const targetPageNode = nodes.find(
          (n) => n.kind === "route" && n.metadata?.routePath === call.stringArg
        );
        if (!targetPageNode) continue;

        const containingFn = parsed.containingFunction(call.line);
        if (!containingFn) continue;

        const actionNode = nodes.find(
          (n) => n.kind === "server_action" && n.symbol === containingFn && n.file === rel
        );
        if (!actionNode) continue;

        edges.push({
          from: actionNode.id,
          to: targetPageNode.id,
          edgeType: "revalidates",
          file: rel,
          line: call.line,
          reason: `Server action ${containingFn} revalidates ${call.stringArg}`,
          adapter: "nextjs",
        });
      }
    }

    // 4. Middleware
    const middlewareFiles = await findFiles(wsRoot, [
      "middleware.ts", "middleware.js",
      "src/middleware.ts", "src/middleware.js",
    ]);
    for (const file of middlewareFiles) {
      const rel = toRelative(file, repoRoot);
      nodes.push({
        id: makeNodeId("middleware", rel, "middleware"),
        kind: "middleware",
        symbol: "middleware",
        file: rel,
        line: 1,
        reason: "Next.js middleware",
        adapter: "nextjs",
        metadata: { framework: "nextjs" },
      });
    }

    // 5. Layouts
    const layoutFiles = await findFiles(wsRoot, [
      "app/**/layout.ts", "app/**/layout.tsx",
      "src/app/**/layout.ts", "src/app/**/layout.tsx",
    ]);
    for (const file of layoutFiles) {
      const rel = toRelative(file, repoRoot);
      const routePath = extractRoutePath(file, wsRoot);
      nodes.push({
        id: makeNodeId("layout", rel, routePath),
        kind: "layout",
        symbol: `Layout(${routePath})`,
        file: rel,
        line: 1,
        reason: `Next.js layout: ${routePath}`,
        adapter: "nextjs",
        metadata: { routePath, framework: "nextjs" },
      });
    }

    return { adapter: "nextjs", nodes, edges };
  },
};

function extractRoutePath(filePath: string, wsRoot: string): string {
  const rel = path.relative(wsRoot, filePath).replace(/\\/g, "/");
  // Remove src/app or app prefix, and the filename
  const withoutFile = path.dirname(rel);
  const route = withoutFile
    .replace(/^src\/app/, "")
    .replace(/^app/, "")
    .replace(/\(.*?\)\/?/g, "") // Remove route groups like (auth)
    || "/";
  return route.startsWith("/") ? route : `/${route}`;
}
