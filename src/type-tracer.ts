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
  chainsTraced: number;
}

interface ResolvedCall {
  symbolName: string;
  line: number;
  targetFile: string | null;
  targetDeclaration: ts.Node | null;
  boundaryNode: BoundaryNode | null; // non-null if this resolves to a boundary node
}

/**
 * Type-aware tracer using ts.createProgram for whole-project type resolution.
 * Follows call chains through intermediate (non-boundary) functions until
 * hitting another boundary node or reaching max depth.
 */
export async function traceWithTypeChecker(options: TypeTraceOptions): Promise<TypeTraceResult> {
  const { repoRoot, nodes, maxDepth = 6 } = options;
  const edges: BoundaryEdge[] = [];
  const seenEdges = new Set<string>();
  let symbolsResolved = 0;
  let chainsTraced = 0;

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

  // Create TypeScript program
  const tsConfigPath = path.join(repoRoot, "tsconfig.json");
  const program = createProgram(tsConfigPath, repoRoot);
  if (!program) {
    return { edges: [], filesAnalyzed: 0, symbolsResolved: 0, chainsTraced: 0 };
  }

  const checker = program.getTypeChecker();
  const boundaryFiles = [...nodesByFile.keys()];
  let filesAnalyzed = 0;

  for (const absPath of boundaryFiles) {
    const sourceFile = program.getSourceFile(absPath);
    if (!sourceFile) continue;
    filesAnalyzed++;

    const sourceNodes = nodesByFile.get(absPath) || [];

    for (const sourceNode of sourceNodes) {
      const declaration = findDeclaration(sourceFile, sourceNode.symbol, sourceNode.line);
      if (!declaration) continue;

      // Deep trace: follow call chains through intermediate functions
      const reachedBoundaryNodes = traceCallChain(
        declaration,
        sourceFile,
        sourceNode,
        checker,
        program,
        nodesByFile,
        nodesBySymbol,
        repoRoot,
        maxDepth
      );

      for (const reached of reachedBoundaryNodes) {
        if (reached.node.id === sourceNode.id) continue;

        const edgeKey = `${sourceNode.id}→${reached.node.id}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);
        symbolsResolved++;

        edges.push({
          from: sourceNode.id,
          to: reached.node.id,
          edgeType: inferSymbolEdgeType(sourceNode, reached.node),
          file: sourceNode.file,
          line: reached.originLine,
          reason: reached.depth === 1
            ? `${sourceNode.symbol} calls ${reached.node.symbol}`
            : `${sourceNode.symbol} → ${reached.chain.join(" → ")} → ${reached.node.symbol}`,
          adapter: "type_trace",
          metadata: {
            resolvedVia: "type_checker",
            depth: reached.depth,
            ...(reached.chain.length > 0 ? { chain: reached.chain } : {}),
          },
        });
      }

      if (reachedBoundaryNodes.length > 0) chainsTraced++;

      // Also trace imports for this declaration
      const importEdges = traceImportsForDeclaration(
        sourceFile, sourceNode, declaration, nodesByFile, nodesBySymbol,
        repoRoot, checker, seenEdges, program.getCompilerOptions()
      );
      edges.push(...importEdges);
    }
  }

  return { edges, filesAnalyzed, symbolsResolved, chainsTraced };
}

interface ReachedBoundaryNode {
  node: BoundaryNode;
  depth: number;
  originLine: number; // line in the source boundary node where the chain starts
  chain: string[]; // intermediate function names
}

/**
 * Follow call chains from a declaration, through intermediate functions,
 * until hitting boundary nodes or max depth.
 */
function traceCallChain(
  startDeclaration: ts.Node,
  startSourceFile: ts.SourceFile,
  sourceNode: BoundaryNode,
  checker: ts.TypeChecker,
  program: ts.Program,
  nodesByFile: Map<string, BoundaryNode[]>,
  nodesBySymbol: Map<string, BoundaryNode[]>,
  repoRoot: string,
  maxDepth: number
): ReachedBoundaryNode[] {
  const reached: ReachedBoundaryNode[] = [];
  const visited = new Set<string>(); // prevent cycles: "file:symbol"

  interface QueueItem {
    declaration: ts.Node;
    sourceFile: ts.SourceFile;
    depth: number;
    originLine: number; // line in the original boundary node
    chain: string[]; // names of intermediate functions
  }

  const queue: QueueItem[] = [{
    declaration: startDeclaration,
    sourceFile: startSourceFile,
    depth: 0,
    originLine: 0,
    chain: [],
  }];

  const startKey = `${startSourceFile.fileName}:${sourceNode.symbol}`;
  visited.add(startKey);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const calls = collectCallsInNode(current.declaration, current.sourceFile, checker);

    for (const call of calls) {
      const originLine = current.depth === 0 ? call.line : current.originLine;

      // Try to resolve the call via the type checker
      const resolved = resolveCall(call, checker, program, nodesByFile, nodesBySymbol, repoRoot);
      if (!resolved) continue;

      // Check if it resolves to a boundary node
      if (resolved.boundaryNode) {
        reached.push({
          node: resolved.boundaryNode,
          depth: current.depth + 1,
          originLine,
          chain: current.chain,
        });
        continue; // Don't follow into boundary nodes — they'll trace their own chains
      }

      // Not a boundary node — follow into the intermediate function
      if (resolved.targetDeclaration && resolved.targetFile) {
        const visitKey = `${resolved.targetFile}:${resolved.symbolName}`;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);

        const targetSourceFile = program.getSourceFile(resolved.targetFile);
        if (!targetSourceFile) continue;

        queue.push({
          declaration: resolved.targetDeclaration,
          sourceFile: targetSourceFile,
          depth: current.depth + 1,
          originLine,
          chain: [...current.chain, resolved.symbolName],
        });
      }
    }
  }

  return reached;
}

/**
 * Resolve a call expression to either a boundary node or an intermediate declaration.
 */
function resolveCall(
  call: CallInfo,
  checker: ts.TypeChecker,
  program: ts.Program,
  nodesByFile: Map<string, BoundaryNode[]>,
  nodesBySymbol: Map<string, BoundaryNode[]>,
  repoRoot: string
): ResolvedCall | null {
  try {
    const callExpr = call.node as ts.CallExpression;
    const symbol = checker.getSymbolAtLocation(callExpr.expression);
    if (!symbol) return null;

    const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

    const declarations = resolvedSymbol.getDeclarations();
    if (!declarations || declarations.length === 0) return null;

    const decl = declarations[0];
    const declFile = decl.getSourceFile().fileName;

    // Skip node_modules / external
    if (declFile.includes("node_modules")) return null;

    // Check if this declaration is in a file with boundary nodes
    const targetBoundaryNodes = nodesByFile.get(declFile);
    let boundaryNode: BoundaryNode | null = null;

    if (targetBoundaryNodes) {
      // Try to match to a specific boundary node
      boundaryNode = targetBoundaryNodes.find((n) => n.symbol === resolvedSymbol.name) || null;
      if (!boundaryNode) {
        // Try line-based match
        const declLine = decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1;
        boundaryNode = targetBoundaryNodes.find((n) => Math.abs(n.line - declLine) <= 3) || null;
      }
    }

    // If not a boundary node, check if it's a unique symbol match
    if (!boundaryNode) {
      const byName = nodesBySymbol.get(resolvedSymbol.name);
      if (byName && byName.length === 1) {
        boundaryNode = byName[0];
      }
    }

    return {
      symbolName: resolvedSymbol.name,
      line: call.line,
      targetFile: declFile,
      targetDeclaration: isFunctionLike(decl) ? decl : findFunctionParent(decl),
      boundaryNode,
    };
  } catch {
    return null;
  }
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isVariableDeclaration(node);
}

function findFunctionParent(node: ts.Node): ts.Node | null {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return node; // fallback to the node itself
}

// --- Shared utilities (same as before) ---

interface CallInfo {
  text: string;
  symbolName: string;
  line: number;
  node: ts.Node;
}

function createProgram(tsConfigPath: string, repoRoot: string): ts.Program | null {
  try {
    const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    if (configFile.error) {
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
        types: [],
      },
    });
  } catch {
    return createFallbackProgram(repoRoot);
  }
}

function createFallbackProgram(repoRoot: string): ts.Program | null {
  try {
    const files = ts.sys.readDirectory(repoRoot, [".ts", ".tsx"], ["node_modules", "dist", ".next"]);
    if (files.length === 0) return null;

    return ts.createProgram({
      rootNames: files.slice(0, 500),
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

  const usedIdentifiers = new Set<string>();
  function collectIdentifiers(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      usedIdentifiers.add(node.text);
    }
    ts.forEachChild(node, collectIdentifiers);
  }
  collectIdentifiers(declaration);

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (node.importClause?.isTypeOnly) return;

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

    const usedImports = importedNames.filter((name) => usedIdentifiers.has(name));
    if (usedImports.length === 0) return;

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
  if (tk === "auth") return "uses_auth";
  if (tk === "rls") return "uses_rls";
  if (tk === "db_helper") return "uses_db_helper";

  return "calls";
}
