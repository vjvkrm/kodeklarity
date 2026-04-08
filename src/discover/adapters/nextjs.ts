import path from "node:path";
import type { FrameworkAdapter, Workspace, AdapterResult, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

export const nextjsAdapter: FrameworkAdapter = {
  name: "nextjs",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "next");
    if (!version) return null;
    return { name: "Next.js", version, adapter: "nextjs" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    // 1. Find pages/routes — app/**/page.{ts,tsx,js,jsx}
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

    // 2. Find API routes — app/**/route.{ts,tsx,js,jsx}
    const routeFiles = await findFiles(wsRoot, [
      "app/**/route.ts", "app/**/route.tsx", "app/**/route.js", "app/**/route.jsx",
      "src/app/**/route.ts", "src/app/**/route.tsx", "src/app/**/route.js", "src/app/**/route.jsx",
    ]);

    for (const file of routeFiles) {
      const rel = toRelative(file, repoRoot);
      const content = await readFileSafe(file);
      if (!content) continue;

      const routePath = extractRoutePath(file, wsRoot);
      const methods = extractHttpMethods(content);

      for (const method of methods) {
        const line = findLineNumber(content, new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`));
        nodes.push({
          id: makeNodeId("api_route", rel, `${method}:${routePath}`),
          kind: "api_route",
          symbol: `${method} ${routePath}`,
          file: rel,
          line,
          reason: `Next.js API route: ${method} ${routePath}`,
          adapter: "nextjs",
          metadata: { routePath, method, framework: "nextjs" },
        });
      }
    }

    // 3. Find server actions — files with 'use server'
    const tsFiles = await findFiles(wsRoot, [
      "**/*.ts", "**/*.tsx",
      "src/**/*.ts", "src/**/*.tsx",
    ]);

    // Filter out node_modules, .next, dist
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;

      // Check for 'use server' directive
      const hasUseServer = /['"]use server['"]/.test(content);
      if (!hasUseServer) continue;

      const rel = toRelative(file, repoRoot);

      // Extract exported functions — these are the server actions
      const exportedFns = extractExportedFunctions(content);
      for (const fn of exportedFns) {
        nodes.push({
          id: makeNodeId("server_action", rel, fn.name),
          kind: "server_action",
          symbol: fn.name,
          file: rel,
          line: fn.line,
          reason: `Next.js server action: ${fn.name}`,
          adapter: "nextjs",
          metadata: { framework: "nextjs" },
        });
      }

      // Check for revalidatePath/revalidateTag calls
      const revalidations = extractRevalidations(content);
      for (const rev of revalidations) {
        // Find which page this revalidation targets
        const targetPageNode = nodes.find(
          (n) => n.kind === "route" && n.metadata?.routePath === rev.path
        );

        if (targetPageNode) {
          // Find which server action contains this revalidation
          const containingAction = findContainingFunction(content, rev.line);
          const actionNode = nodes.find(
            (n) => n.kind === "server_action" && n.symbol === containingAction && n.file === rel
          );

          if (actionNode) {
            edges.push({
              from: actionNode.id,
              to: targetPageNode.id,
              edgeType: "revalidates",
              file: rel,
              line: rev.line,
              reason: `Server action ${containingAction} revalidates ${rev.path}`,
              adapter: "nextjs",
            });
          }
        }
      }
    }

    // 4. Find middleware
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

    // 5. Find layouts
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

function extractHttpMethods(content: string): string[] {
  const methods: string[] = [];
  const methodNames = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  for (const method of methodNames) {
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(content)) {
      methods.push(method);
    }
  }
  return methods;
}

function extractExportedFunctions(content: string): Array<{ name: string; line: number }> {
  const fns: Array<{ name: string; line: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: export async function name( or export function name(
    const match = line.match(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/);
    if (match) {
      fns.push({ name: match[1], line: i + 1 });
      continue;
    }
    // Match: export const name = async (
    const constMatch = line.match(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (constMatch) {
      fns.push({ name: constMatch[1], line: i + 1 });
    }
  }

  return fns;
}

function extractRevalidations(content: string): Array<{ path: string; line: number; type: string }> {
  const results: Array<{ path: string; line: number; type: string }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const pathMatch = lines[i].match(/revalidatePath\s*\(\s*['"]([^'"]+)['"]/);
    if (pathMatch) {
      results.push({ path: pathMatch[1], line: i + 1, type: "path" });
    }
    const tagMatch = lines[i].match(/revalidateTag\s*\(\s*['"]([^'"]+)['"]/);
    if (tagMatch) {
      results.push({ path: tagMatch[1], line: i + 1, type: "tag" });
    }
  }

  return results;
}

function findContainingFunction(content: string, targetLine: number): string | null {
  const lines = content.split("\n");
  // Walk backwards from targetLine to find the nearest function declaration
  for (let i = targetLine - 1; i >= 0; i--) {
    const match = lines[i].match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (match) return match[1];
    const constMatch = lines[i].match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (constMatch) return constMatch[1];
  }
  return null;
}
