import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { BoundaryNode, BoundaryEdge } from "./discover/types.js";

interface TypeTraceOptions {
  repoRoot: string;
  nodes: BoundaryNode[];
  maxDepth?: number;
}

interface TypeTraceResult {
  edges: BoundaryEdge[];
  filesAnalyzed: number;
  symbolsResolved: number;
  fallbackFileEdges: number;
}

/**
 * Type-aware tracer using ts.createProgram for whole-project type resolution.
 * Creates symbol-level edges (functionA → functionB) instead of file-level edges.
 */
export async function traceWithTypeChecker(options: TypeTraceOptions): Promise<TypeTraceResult> {
  const { repoRoot, nodes, maxDepth = 4 } = options;
  const edges: BoundaryEdge[] = [];
  const seenEdges = new Set<string>();
  let symbolsResolved = 0;
  let fallbackFileEdges = 0;

  // Build maps for quick lookup
  const nodesByFile = new Map<string, BoundaryNode[]>();
  const nodesBySymbol = new Map<string, BoundaryNode[]>();

  for (const node of nodes) {
    const absPath = path.resolve(repoRoot, node.file);
    const byFile = nodesByFile.get(absPath) || [];
    byFile.push(node);
    nodesByFile.set(absPath, byFile);

    const bySymbol = nodesBySymbol.get(node.symbol) || [];
    bySymbol.push(node);
    nodesBySymbol.set(node.symbol, bySymbol);
  }

  // Create TypeScript program for the whole project
  const tsConfigPath = path.join(repoRoot, "tsconfig.json");
  const program = createProgram(tsConfigPath, repoRoot);
  if (!program) {
    // Fallback: can't create program, return empty
    return { edges: [], filesAnalyzed: 0, symbolsResolved: 0, fallbackFileEdges: 0 };
  }

  const checker = program.getTypeChecker();
  const boundaryFiles = [...nodesByFile.keys()];
  let filesAnalyzed = 0;

  for (const absPath of boundaryFiles) {
    const sourceFile = program.getSourceFile(absPath);
    if (!sourceFile) continue;
    filesAnalyzed++;

    const sourceNodes = nodesByFile.get(absPath) || [];

    // For each boundary node in this file, find what it calls
    for (const sourceNode of sourceNodes) {
      // Find the function/variable declaration for this symbol
      const declaration = findDeclaration(sourceFile, sourceNode.symbol, sourceNode.line);
      if (!declaration) continue;

      // Collect all call expressions within this declaration
      const calls = collectCallsInNode(declaration, sourceFile, checker);

      for (const call of calls) {
        // Try to resolve the call target to a boundary node
        const targetNode = resolveCallToBoundaryNode(
          call, checker, nodesByFile, nodesBySymbol, repoRoot
        );

        if (targetNode && targetNode.id !== sourceNode.id) {
          const edgeKey = `${sourceNode.id}→${targetNode.id}`;
          if (seenEdges.has(edgeKey)) continue;
          seenEdges.add(edgeKey);
          symbolsResolved++;

          edges.push({
            from: sourceNode.id,
            to: targetNode.id,
            edgeType: inferSymbolEdgeType(sourceNode, targetNode),
            file: sourceNode.file,
            line: call.line,
            reason: `${sourceNode.symbol} calls ${targetNode.symbol}`,
            adapter: "type_trace",
            metadata: {
              callExpression: call.text,
              resolvedVia: "type_checker",
            },
          });
        }
      }

      // Also trace imports to find boundary nodes this declaration depends on
      // (for cases where the type checker can't resolve but import is clear)
      const importEdges = traceImportsForDeclaration(
        sourceFile, sourceNode, declaration, nodesByFile, nodesBySymbol,
        repoRoot, checker, seenEdges, program.getCompilerOptions()
      );
      for (const edge of importEdges) {
        fallbackFileEdges++;
        edges.push(edge);
      }
    }
  }

  return { edges, filesAnalyzed, symbolsResolved, fallbackFileEdges };
}

interface CallInfo {
  text: string;
  symbolName: string;
  line: number;
  node: ts.Node;
}

function createProgram(tsConfigPath: string, repoRoot: string): ts.Program | null {
  try {
    // Try to read tsconfig
    const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    if (configFile.error) {
      // No tsconfig — create a basic program from all TS files
      return createFallbackProgram(repoRoot);
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(tsConfigPath)
    );

    return ts.createProgram({
      rootNames: parsed.fileNames,
      options: {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
        // Don't resolve all libs — we just need type info
        types: [],
      },
    });
  } catch {
    return createFallbackProgram(repoRoot);
  }
}

function createFallbackProgram(repoRoot: string): ts.Program | null {
  try {
    // Find TS files manually
    const files: string[] = [];
    function walk(dir: string) {
      const entries = ts.sys.readDirectory(dir, [".ts", ".tsx"], ["node_modules", "dist", ".next"]);
      files.push(...entries);
    }
    walk(repoRoot);

    if (files.length === 0) return null;

    return ts.createProgram({
      rootNames: files.slice(0, 500), // Cap to avoid OOM on huge repos
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
    });
  } catch {
    return null;
  }
}

function findDeclaration(
  sourceFile: ts.SourceFile,
  symbolName: string,
  lineHint: number
): ts.Node | null {
  let best: ts.Node | null = null;
  let bestLineDelta = Infinity;

  function visit(node: ts.Node) {
    let name: string | null = null;

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
    }

    if (name === symbolName) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const delta = Math.abs(line - lineHint);
      if (delta < bestLineDelta) {
        bestLineDelta = delta;
        best = node;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return best;
}

function collectCallsInNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): CallInfo[] {
  const calls: CallInfo[] = [];

  function visit(child: ts.Node) {
    if (ts.isCallExpression(child)) {
      const expr = child.expression;
      let symbolName = "";

      if (ts.isIdentifier(expr)) {
        symbolName = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        symbolName = expr.name.text;
      }

      if (symbolName) {
        const line = sourceFile.getLineAndCharacterOfPosition(child.getStart(sourceFile)).line + 1;
        calls.push({
          text: symbolName,
          symbolName,
          line,
          node: child,
        });
      }
    }

    ts.forEachChild(child, visit);
  }

  visit(node);
  return calls;
}

function resolveCallToBoundaryNode(
  call: CallInfo,
  checker: ts.TypeChecker,
  nodesByFile: Map<string, BoundaryNode[]>,
  nodesBySymbol: Map<string, BoundaryNode[]>,
  repoRoot: string
): BoundaryNode | null {
  // Strategy 1: Use type checker to resolve the symbol
  try {
    const callExpr = call.node as ts.CallExpression;
    const symbol = checker.getSymbolAtLocation(callExpr.expression);
    if (symbol) {
      const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;

      const declarations = resolvedSymbol.getDeclarations();
      if (declarations && declarations.length > 0) {
        const decl = declarations[0];
        const declFile = decl.getSourceFile().fileName;
        const declNodes = nodesByFile.get(declFile);

        if (declNodes) {
          // Find the specific boundary node in that file
          const match = declNodes.find((n) => n.symbol === resolvedSymbol.name);
          if (match) return match;

          // Try line-based match
          const declLine = decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1;
          const lineMatch = declNodes.find((n) => Math.abs(n.line - declLine) <= 3);
          if (lineMatch) return lineMatch;
        }
      }
    }
  } catch {
    // Type checker failed — fall through to heuristic
  }

  // Strategy 2: Heuristic — match by symbol name
  const byName = nodesBySymbol.get(call.symbolName);
  if (byName && byName.length === 1) {
    return byName[0]; // Unique match
  }

  return null;
}

function traceImportsForDeclaration(
  sourceFile: ts.SourceFile,
  sourceNode: BoundaryNode,
  declaration: ts.Node,
  nodesByFile: Map<string, BoundaryNode[]>,
  nodesBySymbol: Map<string, BoundaryNode[]>,
  repoRoot: string,
  checker: ts.TypeChecker,
  seenEdges: Set<string>,
  compilerOptions?: ts.CompilerOptions
): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];

  // Find all identifiers used in the declaration that come from imports
  const usedIdentifiers = new Set<string>();
  function collectIdentifiers(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      usedIdentifiers.add(node.text);
    }
    ts.forEachChild(node, collectIdentifiers);
  }
  collectIdentifiers(declaration);

  // Check file-level imports
  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (node.importClause?.isTypeOnly) return;

    // Get imported names
    const importedNames: string[] = [];
    if (node.importClause?.name) {
      importedNames.push(node.importClause.name.text);
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (!el.isTypeOnly) {
          importedNames.push(el.name.text);
        }
      }
    }

    // Check which imported names are actually used in our declaration
    const usedImports = importedNames.filter((name) => usedIdentifiers.has(name));
    if (usedImports.length === 0) return;

    // Resolve the module to find target boundary nodes
    try {
      const resolved = ts.resolveModuleName(
        node.moduleSpecifier.text,
        sourceFile.fileName,
        compilerOptions || {},
        ts.sys
      );

      const resolvedFile = resolved.resolvedModule?.resolvedFileName;
      if (!resolvedFile) return;

      const targetNodes = nodesByFile.get(resolvedFile);
      if (!targetNodes) return;

      // Match used imports to specific boundary nodes
      for (const importName of usedImports) {
        const targetNode = targetNodes.find((n) => n.symbol === importName);
        if (targetNode && targetNode.id !== sourceNode.id) {
          const edgeKey = `${sourceNode.id}→${targetNode.id}`;
          if (seenEdges.has(edgeKey)) continue;
          seenEdges.add(edgeKey);

          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          edges.push({
            from: sourceNode.id,
            to: targetNode.id,
            edgeType: inferSymbolEdgeType(sourceNode, targetNode),
            file: sourceNode.file,
            line,
            reason: `${sourceNode.symbol} uses ${importName} from ${path.relative(repoRoot, resolvedFile)}`,
            adapter: "type_trace",
            metadata: {
              importedSymbol: importName,
              resolvedVia: "import_usage",
            },
          });
        }
      }
    } catch {
      // Module resolution failed
    }
  });

  return edges;
}

function inferSymbolEdgeType(source: BoundaryNode, target: BoundaryNode): string {
  const sk = source.kind;
  const tk = target.kind;

  if (tk === "table") return "uses_table";
  if (tk === "rls_policy") return "uses_policy";
  if (tk === "external_api") return "calls_external";
  if (tk === "background_job") return "triggers_job";
  if (tk === "event") return "emits_event";
  if (sk === "route" && tk === "server_action") return "invokes_action";
  if (sk === "layout" && tk === "server_action") return "invokes_action";
  if ((sk === "server_action" || sk === "api_route" || sk === "controller") && tk === "service") return "invokes_service";
  if ((sk === "server_action" || sk === "api_route" || sk === "controller") && tk === "query") return "queries_data";
  if (sk === "service" && tk === "query") return "queries_data";
  if (sk === "query" && tk === "table") return "reads_table";
  if (tk === "hook") return "uses_hook";
  if (tk === "context") return "uses_context";
  if (sk === "server_action" && tk === "server_action") return "calls";

  return "calls";
}
