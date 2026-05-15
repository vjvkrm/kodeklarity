import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";
import { parseFile, type ParsedFile, type ParsedDecorator } from "../ast-helpers.js";

const HTTP_METHOD_DECORATORS = ["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All"];

export const nestjsAdapter: FrameworkAdapter = {
  name: "nestjs",
  maturity: "experimental",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "@nestjs/core");
    if (!version) return null;
    return { name: "NestJS", version, adapter: "nestjs", maturity: "experimental" };
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
      // Cheap reject: if no NestJS decorator appears at all, skip parsing.
      if (!/@(Controller|Injectable|Module|UseGuards|UseInterceptors)\b/.test(content)) continue;

      const rel = toRelative(file, repoRoot);
      const parsed = parseFile(file, content);

      collectControllers(parsed, rel, nodes);
      collectInjectables(parsed, rel, nodes);
      collectModules(parsed, rel, nodes);
      collectGuardsAndInterceptors(parsed, rel, nodes);
    }

    return { adapter: "nestjs", nodes, edges };
  },
};

function collectControllers(parsed: ParsedFile, rel: string, nodes: BoundaryNode[]): void {
  const controllers = parsed.findDecoratorsByName("Controller");
  for (const ctrl of controllers) {
    if (ctrl.appliedTo.kind !== "class") continue;
    const className = ctrl.appliedTo.name;
    const routePrefix = firstStringArg(ctrl) ?? "";

    nodes.push({
      id: makeNodeId("controller", rel, className),
      kind: "controller",
      symbol: className,
      file: rel,
      line: ctrl.appliedTo.line,
      reason: `NestJS controller: ${className} (/${routePrefix})`,
      adapter: "nestjs",
      metadata: { routePrefix, framework: "nestjs" },
    });

    // Method-level HTTP decorators scoped to THIS class via parentClass.
    for (const httpDecorator of HTTP_METHOD_DECORATORS) {
      const methods = parsed
        .findDecoratorsByName(httpDecorator)
        .filter((d) => d.appliedTo.kind === "method" && d.appliedTo.parentClass === className);

      for (const m of methods) {
        const httpMethod = httpDecorator.toUpperCase();
        const routePath = firstStringArg(m) ?? "";
        const methodName = m.appliedTo.name;
        // Join prefix + path, collapse repeated slashes, drop trailing slash
        // (so empty routePath yields "/prefix" not "/prefix/").
        const fullPath = `/${routePrefix}/${routePath}`
          .replace(/\/+/g, "/")
          .replace(/\/$/, "") || "/";

        nodes.push({
          id: makeNodeId("api_route", rel, `${httpMethod}:${fullPath}`),
          kind: "api_route",
          symbol: `${httpMethod} ${fullPath}`,
          file: rel,
          line: m.appliedTo.line,
          reason: `NestJS route handler: ${className}.${methodName}`,
          adapter: "nestjs",
          metadata: { httpMethod, routePrefix, routePath, methodName, framework: "nestjs" },
        });
      }
    }
  }
}

function collectInjectables(parsed: ParsedFile, rel: string, nodes: BoundaryNode[]): void {
  const injectables = parsed.findDecoratorsByName("Injectable");
  for (const inj of injectables) {
    if (inj.appliedTo.kind !== "class") continue;
    const className = inj.appliedTo.name;
    // Don't double-register if this class is already a controller.
    if (nodes.some((n) => n.symbol === className && n.kind === "controller" && n.file === rel)) continue;

    nodes.push({
      id: makeNodeId("service", rel, className),
      kind: "service",
      symbol: className,
      file: rel,
      line: inj.appliedTo.line,
      reason: `NestJS injectable service: ${className}`,
      adapter: "nestjs",
      metadata: { framework: "nestjs" },
    });
  }
}

function collectModules(parsed: ParsedFile, rel: string, nodes: BoundaryNode[]): void {
  const modules = parsed.findDecoratorsByName("Module");
  for (const mod of modules) {
    if (mod.appliedTo.kind !== "class") continue;
    const className = mod.appliedTo.name;
    nodes.push({
      id: makeNodeId("module", rel, className),
      kind: "module",
      symbol: className,
      file: rel,
      line: mod.appliedTo.line,
      reason: `NestJS module: ${className}`,
      adapter: "nestjs",
      metadata: { framework: "nestjs" },
    });
  }
}

function collectGuardsAndInterceptors(parsed: ParsedFile, rel: string, nodes: BoundaryNode[]): void {
  const pairs: Array<{ decoratorName: string; nodeKind: "guard" | "interceptor" }> = [
    { decoratorName: "UseGuards", nodeKind: "guard" },
    { decoratorName: "UseInterceptors", nodeKind: "interceptor" },
  ];
  for (const { decoratorName, nodeKind } of pairs) {
    const decorators = parsed.findDecoratorsByName(decoratorName);
    for (const dec of decorators) {
      // Arguments are typically identifiers (class names). The AST gives us each
      // argument separately — no fragile comma-splitting on string content.
      const identifierArgs = dec.args
        .filter((a) => a.kind === "identifier" && a.value)
        .map((a) => a.value as string);

      for (const name of identifierArgs) {
        nodes.push({
          id: makeNodeId(nodeKind, rel, name),
          kind: nodeKind,
          symbol: name,
          file: rel,
          line: dec.line,
          reason: `NestJS ${nodeKind}: ${name}`,
          adapter: "nestjs",
          metadata: { framework: "nestjs" },
        });
      }
    }
  }
}

/** Get the first string-literal argument from a decorator, if present. */
function firstStringArg(dec: ParsedDecorator): string | undefined {
  const first = dec.args[0];
  return first?.kind === "string" ? first.value : undefined;
}
