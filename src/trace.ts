import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { BoundaryNode, BoundaryEdge } from "./discover/types.js";

interface WorkspacePackage {
  name: string;
  absPath: string;
  exports: Record<string, string>; // e.g. { ".": "./src/index.ts", "./schema": "./src/schema.ts" }
}

interface TraceOptions {
  repoRoot: string;
  nodes: BoundaryNode[];
  maxDepth?: number;
}

interface TraceResult {
  edges: BoundaryEdge[];
  filesTraced: number;
  edgesFound: number;
}

interface ParsedImport {
  moduleSpecifier: string;
  importedSymbols: string[]; // named imports, or ["*"] for namespace, ["default"] for default
  line: number;
  isTypeOnly: boolean;
}

interface FileInfo {
  absPath: string;
  relPath: string;
  imports: ParsedImport[];
  exportedSymbols: string[];
}

/**
 * Trace import relationships between discovered boundary nodes.
 * For each boundary node file, find what it imports and what imports it.
 * Create edges when import chains connect two boundary nodes.
 */
export async function traceImportEdges(options: TraceOptions): Promise<TraceResult> {
  const { repoRoot, nodes, maxDepth = 5 } = options;
  const edges: BoundaryEdge[] = [];

  // Build a map of file → boundary nodes in that file
  const nodesByFile = new Map<string, BoundaryNode[]>();
  for (const node of nodes) {
    const absPath = path.resolve(repoRoot, node.file);
    const existing = nodesByFile.get(absPath) || [];
    existing.push(node);
    nodesByFile.set(absPath, existing);
  }

  // Get all unique files that contain boundary nodes
  const boundaryFiles = [...nodesByFile.keys()];

  // Load tsconfig for alias resolution
  const tsConfigPath = path.join(repoRoot, "tsconfig.json");
  const aliasMap = await loadTsConfigPaths(tsConfigPath);

  // Load workspace packages for monorepo import resolution
  const workspacePackages = await loadWorkspacePackages(repoRoot);

  // Parse all boundary files to get their imports
  const fileCache = new Map<string, FileInfo>();
  let filesTraced = 0;

  for (const absPath of boundaryFiles) {
    await parseFileInfo(absPath, repoRoot, fileCache);
    filesTraced++;
  }

  // For each boundary file, trace its imports to find connections to other boundary files
  const seenEdges = new Set<string>();

  for (const [sourceFile, sourceNodes] of nodesByFile) {
    const sourceInfo = fileCache.get(sourceFile);
    if (!sourceInfo) continue;

    // BFS through imports to find connections to other boundary files
    const visited = new Set<string>([sourceFile]);
    const queue: Array<{ absPath: string; depth: number; chain: string[] }> = [];

    // Seed queue with direct imports
    for (const imp of sourceInfo.imports) {
      if (imp.isTypeOnly) continue; // Skip type-only imports for runtime relationships

      const resolved = await resolveImport(imp.moduleSpecifier, sourceFile, repoRoot, aliasMap, workspacePackages);
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved);
        queue.push({ absPath: resolved, depth: 1, chain: [sourceFile, resolved] });
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Check if this file contains boundary nodes
      const targetNodes = nodesByFile.get(current.absPath);
      if (targetNodes) {
        // Create edges from source nodes to target nodes
        for (const sn of sourceNodes) {
          for (const tn of targetNodes) {
            if (sn.id === tn.id) continue; // Don't self-link
            const edgeKey = `${sn.id}→${tn.id}`;
            if (seenEdges.has(edgeKey)) continue;
            seenEdges.add(edgeKey);

            const edgeType = inferEdgeType(sn, tn, current.depth);
            edges.push({
              from: sn.id,
              to: tn.id,
              edgeType,
              file: sn.file,
              line: findImportLine(fileCache.get(sourceFile), current.chain),
              reason: `${sn.symbol} → ${tn.symbol} (via ${current.depth === 1 ? "direct import" : `${current.depth}-hop import chain`})`,
              adapter: "ast_trace",
              metadata: {
                depth: current.depth,
                chain: current.chain.map((p) => path.relative(repoRoot, p)),
              },
            });
          }
        }
      }

      // Continue BFS if under depth limit
      if (current.depth < maxDepth) {
        const info = await parseFileInfo(current.absPath, repoRoot, fileCache);
        if (info) {
          filesTraced++;
          for (const imp of info.imports) {
            if (imp.isTypeOnly) continue;
            const resolved = await resolveImport(imp.moduleSpecifier, current.absPath, repoRoot, aliasMap, workspacePackages);
            if (resolved && !visited.has(resolved)) {
              visited.add(resolved);
              queue.push({
                absPath: resolved,
                depth: current.depth + 1,
                chain: [...current.chain, resolved],
              });
            }
          }
        }
      }
    }
  }

  return { edges, filesTraced, edgesFound: edges.length };
}

async function parseFileInfo(
  absPath: string,
  repoRoot: string,
  cache: Map<string, FileInfo>
): Promise<FileInfo | null> {
  if (cache.has(absPath)) return cache.get(absPath)!;

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }

  const sourceFile = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);
  const imports: ParsedImport[] = [];
  const exportedSymbols: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    // Collect imports
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const isTypeOnly = node.importClause?.isTypeOnly ?? false;
      const symbols: string[] = [];

      if (node.importClause) {
        if (node.importClause.name) {
          symbols.push("default");
        }
        const bindings = node.importClause.namedBindings;
        if (bindings) {
          if (ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              symbols.push(el.name.text);
            }
          } else if (ts.isNamespaceImport(bindings)) {
            symbols.push("*");
          }
        }
      }

      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      imports.push({
        moduleSpecifier: spec,
        importedSymbols: symbols,
        line: pos.line + 1,
        isTypeOnly,
      });
    }

    // Collect exports
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      exportedSymbols.push(node.name.text);
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exportedSymbols.push(decl.name.text);
        }
      }
    }
    if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node)) {
      exportedSymbols.push(node.name.text);
    }
  });

  const info: FileInfo = {
    absPath,
    relPath: path.relative(repoRoot, absPath),
    imports,
    exportedSymbols,
  };

  cache.set(absPath, info);
  return info;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

async function resolveImport(
  specifier: string,
  fromFile: string,
  repoRoot: string,
  aliasMap: Map<string, string>,
  workspacePackages: WorkspacePackage[] = []
): Promise<string | null> {
  // Skip node_modules / external packages — but check workspace packages first
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("~/")) {
    // Check workspace packages (e.g. @sastrify/db/schema → packages/db/src/schema.ts)
    for (const wp of workspacePackages) {
      if (specifier === wp.name || specifier.startsWith(wp.name + "/")) {
        const subpath = specifier === wp.name ? "." : "./" + specifier.slice(wp.name.length + 1);
        const exportTarget = wp.exports[subpath] || wp.exports[subpath + "/index"];
        if (exportTarget) {
          const resolved = path.resolve(wp.absPath, exportTarget);
          return tryResolveFile(resolved);
        }
        // Fallback: try resolving subpath directly in package dir
        if (subpath !== ".") {
          const resolved = await tryResolveFile(path.resolve(wp.absPath, subpath.slice(2)));
          if (resolved) return resolved;
          // Try src/ subdirectory
          const srcResolved = await tryResolveFile(path.resolve(wp.absPath, "src", subpath.slice(2)));
          if (srcResolved) return srcResolved;
        } else {
          // Try package main/index
          const resolved = await tryResolveFile(path.resolve(wp.absPath, "src", "index"));
          if (resolved) return resolved;
        }
      }
    }

    // Check alias map (tsconfig paths)
    for (const [alias, target] of aliasMap) {
      if (specifier.startsWith(alias)) {
        const rest = specifier.slice(alias.length);
        const resolved = path.resolve(repoRoot, target + rest);
        return tryResolveFile(resolved);
      }
    }
    return null; // External package
  }

  // Relative import
  if (specifier.startsWith(".")) {
    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, specifier);
    return tryResolveFile(resolved);
  }

  // @/ or ~/ alias (common convention)
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    const rest = specifier.slice(2);
    // Try src/ and root
    for (const base of [path.join(repoRoot, "src"), repoRoot]) {
      const resolved = await tryResolveFile(path.resolve(base, rest));
      if (resolved) return resolved;
    }
  }

  return null;
}

async function tryResolveFile(basePath: string): Promise<string | null> {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

  // Try exact path
  if (await fileExists(basePath)) return basePath;

  // Try with extensions
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (await fileExists(withExt)) return withExt;
  }

  // Try as directory with index
  for (const ext of extensions) {
    const indexPath = path.join(basePath, "index" + ext);
    if (await fileExists(indexPath)) return indexPath;
  }

  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function loadTsConfigPaths(tsConfigPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(tsConfigPath, "utf8");
    const config = ts.parseConfigFileTextToJson(tsConfigPath, raw);
    const paths = config.config?.compilerOptions?.paths as Record<string, string[]> | undefined;
    const baseUrl = config.config?.compilerOptions?.baseUrl as string | undefined;
    const configDir = path.dirname(tsConfigPath);
    const base = baseUrl ? path.resolve(configDir, baseUrl) : configDir;

    if (paths) {
      for (const [alias, targets] of Object.entries(paths)) {
        if (targets.length > 0) {
          // Convert "~/*" → "~/" and "./src/*" → "./src/"
          const cleanAlias = alias.replace(/\/?\*$/, "");
          const cleanTarget = targets[0].replace(/\/?\*$/, "");
          const absTarget = path.resolve(base, cleanTarget);
          const relTarget = path.relative(path.dirname(tsConfigPath), absTarget);
          map.set(cleanAlias, relTarget.startsWith(".") ? relTarget : "./" + relTarget);
        }
      }
    }
  } catch {
    // No tsconfig or no paths
  }
  return map;
}

function inferEdgeType(source: BoundaryNode, target: BoundaryNode, depth: number): string {
  // Infer edge type from the kinds of source and target
  const sk = source.kind;
  const tk = target.kind;

  if (tk === "table") return sk === "table" ? "relates_to" : "uses_table";
  if (tk === "external_api") return "calls_external";
  if (tk === "background_job") return "triggers_job";
  if (tk === "event") return "emits_event";
  if (sk === "route" && tk === "server_action") return "invokes_action";
  if (sk === "server_action" && tk === "service") return "invokes_service";
  if (sk === "controller" && tk === "service") return "invokes_service";
  if (sk === "api_route" && tk === "service") return "invokes_service";
  if (sk === "server_action" && tk === "server_action") return "calls";
  if (tk === "hook") return "uses_hook";
  if (tk === "context") return "uses_context";

  return "imports";
}

function findImportLine(info: FileInfo | undefined, chain: string[]): number {
  if (!info || chain.length < 2) return 1;
  const target = chain[1];
  for (const imp of info.imports) {
    // Rough match — the import that could resolve to the second file in the chain
    if (target.includes(imp.moduleSpecifier.replace(/^\.\//, "").replace(/\.\.\//g, ""))) {
      return imp.line;
    }
  }
  return 1;
}

async function loadWorkspacePackages(repoRoot: string): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];

  try {
    const rootPkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const rootPkg = JSON.parse(rootPkgRaw);

    // Get workspace patterns
    let patterns: string[] = [];
    if (Array.isArray(rootPkg.workspaces)) {
      patterns = rootPkg.workspaces;
    } else if (rootPkg.workspaces?.packages) {
      patterns = rootPkg.workspaces.packages;
    }

    if (patterns.length === 0) return packages;

    // Resolve workspace directories
    for (const pattern of patterns) {
      const { glob } = await import("node:fs/promises");
      try {
        for await (const entry of glob(path.join(repoRoot, pattern))) {
          const entryPath = typeof entry === "string" ? entry : String(entry);
          const pkgJsonPath = path.join(entryPath, "package.json");

          try {
            const pkgRaw = await fs.readFile(pkgJsonPath, "utf8");
            const pkg = JSON.parse(pkgRaw);
            if (!pkg.name) continue;

            // Parse exports field
            const exports: Record<string, string> = {};
            if (pkg.exports) {
              if (typeof pkg.exports === "string") {
                exports["."] = pkg.exports;
              } else if (typeof pkg.exports === "object") {
                for (const [key, value] of Object.entries(pkg.exports)) {
                  if (typeof value === "string") {
                    exports[key] = value;
                  } else if (typeof value === "object" && value !== null) {
                    // Handle conditional exports: { import: "./src/index.ts", require: "..." }
                    const v = value as Record<string, unknown>;
                    const resolved = (v.import || v.default || v.require || Object.values(v)[0]) as string;
                    if (typeof resolved === "string") {
                      exports[key] = resolved;
                    }
                  }
                }
              }
            }

            // Fallback to main/module if no exports
            if (Object.keys(exports).length === 0) {
              if (pkg.main) exports["."] = pkg.main;
              else if (pkg.module) exports["."] = pkg.module;
            }

            packages.push({
              name: pkg.name,
              absPath: entryPath,
              exports,
            });
          } catch {
            // Skip packages without valid package.json
          }
        }
      } catch {
        // Pattern didn't match
      }
    }
  } catch {
    // No root package.json
  }

  return packages;
}
