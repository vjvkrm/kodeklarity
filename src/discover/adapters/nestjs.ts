import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

export const nestjsAdapter: FrameworkAdapter = {
  name: "nestjs",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "@nestjs/core");
    if (!version) return null;
    return { name: "NestJS", version, adapter: "nestjs" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    const tsFiles = await findFiles(wsRoot, ["**/*.ts"]);
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = toRelative(file, repoRoot);

      // Find @Controller() classes
      const controllerMatch = content.match(/@Controller\s*\(\s*['"]?([^'")]*)?['"]?\s*\)/);
      if (controllerMatch) {
        const routePrefix = controllerMatch[1] || "";
        const classMatch = content.match(/class\s+(\w+)/);
        const className = classMatch?.[1] || "UnknownController";
        const line = findLineNumber(content, controllerMatch[0]);

        nodes.push({
          id: makeNodeId("controller", rel, className),
          kind: "controller",
          symbol: className,
          file: rel,
          line,
          reason: `NestJS controller: ${className} (/${routePrefix})`,
          adapter: "nestjs",
          metadata: { routePrefix, framework: "nestjs" },
        });

        // Find route handlers — @Get(), @Post(), etc.
        const methodDecorators = [
          ...content.matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*['"]?([^'")]*)?['"]?\s*\)/g),
        ];

        for (const md of methodDecorators) {
          const httpMethod = md[1].toUpperCase();
          const routePath = md[2] || "";
          const handlerLine = findLineNumber(content, md[0]);

          // Find the method name on the next line(s)
          const afterDecorator = content.slice(content.indexOf(md[0]) + md[0].length);
          const methodNameMatch = afterDecorator.match(/(?:async\s+)?(\w+)\s*\(/);
          const methodName = methodNameMatch?.[1] || "unknownHandler";

          nodes.push({
            id: makeNodeId("api_route", rel, `${httpMethod}:/${routePrefix}/${routePath}`),
            kind: "api_route",
            symbol: `${httpMethod} /${routePrefix}/${routePath}`.replace(/\/+/g, "/"),
            file: rel,
            line: handlerLine,
            reason: `NestJS route handler: ${className}.${methodName}`,
            adapter: "nestjs",
            metadata: { httpMethod, routePrefix, routePath, methodName, framework: "nestjs" },
          });
        }
      }

      // Find @Injectable() services
      if (content.includes("@Injectable()")) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          const className = classMatch[1];
          const line = findLineNumber(content, "@Injectable()");

          // Skip if already registered as controller
          if (!nodes.some((n) => n.symbol === className && n.kind === "controller")) {
            nodes.push({
              id: makeNodeId("service", rel, className),
              kind: "service",
              symbol: className,
              file: rel,
              line,
              reason: `NestJS injectable service: ${className}`,
              adapter: "nestjs",
              metadata: { framework: "nestjs" },
            });
          }
        }
      }

      // Find @Module() definitions
      const moduleMatch = content.match(/@Module\s*\(\s*\{/);
      if (moduleMatch) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          const className = classMatch[1];
          const line = findLineNumber(content, moduleMatch[0]);

          nodes.push({
            id: makeNodeId("module", rel, className),
            kind: "module",
            symbol: className,
            file: rel,
            line,
            reason: `NestJS module: ${className}`,
            adapter: "nestjs",
            metadata: { framework: "nestjs" },
          });
        }
      }

      // Find guards and interceptors
      for (const decorator of ["@UseGuards", "@UseInterceptors"]) {
        if (content.includes(decorator)) {
          const matches = [...content.matchAll(new RegExp(`${decorator.replace("@", "@")}\\s*\\(([^)]+)\\)`, "g"))];
          for (const m of matches) {
            const guardNames = m[1].split(",").map((s) => s.trim()).filter(Boolean);
            const line = findLineNumber(content, m[0]);
            const kind = decorator.includes("Guard") ? "guard" : "interceptor";

            for (const name of guardNames) {
              nodes.push({
                id: makeNodeId(kind, rel, name),
                kind,
                symbol: name,
                file: rel,
                line,
                reason: `NestJS ${kind}: ${name}`,
                adapter: "nestjs",
                metadata: { framework: "nestjs" },
              });
            }
          }
        }
      }
    }

    return { adapter: "nestjs", nodes, edges };
  },
};
