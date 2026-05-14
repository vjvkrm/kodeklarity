// Shared AST helpers for framework adapters.
//
// Adapters used to do detection with regex on file contents. That's fast but
// has well-known failure modes:
//   - Matches in comments / strings (`// revalidatePath` triggers a false positive)
//   - Misses non-standard whitespace formatting
//   - Can't follow imports to know which `revalidatePath` was actually called
//   - Can't reliably scope directives ("use server" inside a function vs at file top)
//
// This module wraps `ts.createSourceFile` (the per-file API, not the heavier
// `createProgram`) and exposes a small, focused surface that covers what every
// existing adapter needs. Contributors writing new adapters should prefer
// `parseFile()` over raw regex — see docs/CONTRIBUTING-ADAPTERS.md.
//
// Cost: ~1ms per file. Independent per file (no shared program state).

import * as ts from "typescript";
import path from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ParsedImport {
  /** The module being imported from, e.g. "next/cache". */
  source: string;
  /** Named imports: `["foo", "bar"]` from `import { foo, bar } from "..."`. */
  specifiers: string[];
  /** Default import name: `"React"` from `import React from "react"`. */
  defaultImport?: string;
  /** Namespace import name: `"ts"` from `import * as ts from "typescript"`. */
  namespaceImport?: string;
  line: number;
}

export type ParsedArgKind =
  | "string"
  | "number"
  | "boolean"
  | "identifier"
  | "object"
  | "array"
  | "other";

export interface ParsedArg {
  kind: ParsedArgKind;
  /** For string/number/boolean/identifier, the literal value as a string. */
  value?: string;
  /** For object args, top-level string-literal property values keyed by property name. */
  properties?: Record<string, ParsedArg>;
}

export type ParsedExportKind =
  | "function"
  | "asyncFunction"
  | "constArrow"
  | "constAsyncArrow"
  | "const"
  | "class"
  | "type"
  | "interface"
  | "reExport"
  | "default";

export interface ParsedExport {
  name: string;
  line: number;
  kind: ParsedExportKind;
  /** For consts whose initializer is a call expression, e.g. `const x = pgTable("foo", {...})`. */
  initializerCall?: { callee: string; args: ParsedArg[] };
  /**
   * The first directive inside the function body, if any.
   *   `export async function foo() { "use server"; ... }`  →  "use server"
   * Modern Next.js 15+ uses this per-function pattern.
   */
  bodyDirective?: string;
}

export interface ParsedCallSite {
  /** The callee identifier name. For `foo()` it's "foo"; for `obj.bar()` it's "bar"; for `obj.foo.bar()` it's "bar". */
  callee: string;
  line: number;
  args: ParsedArg[];
}

export interface ParsedDecorator {
  /** The decorator's identifier name, e.g. "Controller", "Get". */
  name: string;
  line: number;
  args: ParsedArg[];
  appliedTo: {
    kind: "class" | "method" | "property";
    name: string;
    line: number;
    /** For method/property decorators, the enclosing class name. Needed to scope decorators to their owning class (e.g., which @Get belongs to which @Controller). */
    parentClass?: string;
  };
}

export interface ParsedFile {
  filePath: string;
  /** The underlying SourceFile, in case an adapter needs deeper AST access. */
  sourceFile: ts.SourceFile;

  imports: ParsedImport[];
  /** File-level directives — e.g., `"use server";` at top of file. */
  fileDirectives: string[];
  exports: ParsedExport[];
  decorators: ParsedDecorator[];

  /** Was a specific named symbol imported (optionally from a specific source)? */
  hasImport(specifier: string, fromSource?: string): boolean;

  /** Find all call expressions where the callee identifier matches `name`. */
  findCalls(name: string): ParsedCallSite[];

  /** Find calls to `name` whose first arg is a string literal. Convenience for `revalidatePath("/foo")` patterns. */
  findCallsWithStringArg(name: string): Array<ParsedCallSite & { stringArg: string }>;

  /** Walk parents from a line up to find the enclosing function/method name, if any. */
  containingFunction(line: number): string | null;

  /** Find all decorators with a given name. */
  findDecoratorsByName(name: string): ParsedDecorator[];
}

// ─── Entry point ───────────────────────────────────────────────────────────

/** Parse a single file into a queryable ParsedFile. ~1ms per file. */
export function parseFile(filePath: string, content: string): ParsedFile {
  const scriptKind = scriptKindFor(filePath);
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind
  );

  const imports: ParsedImport[] = [];
  const fileDirectives: string[] = [];
  const exports: ParsedExport[] = [];
  const decorators: ParsedDecorator[] = [];

  // Pass 1: top-level statements → imports, file directives, exports
  for (const statement of sourceFile.statements) {
    // File-level directive: ExpressionStatement whose expression is a StringLiteral,
    // appearing before any non-directive statement at the top of the file.
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      isLeadingDirective(sourceFile, statement)
    ) {
      fileDirectives.push(statement.expression.text);
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      const parsed = parseImport(sourceFile, statement);
      if (parsed) imports.push(parsed);
      continue;
    }

    // Exports
    const exp = parseExport(sourceFile, statement);
    if (exp) exports.push(exp);
  }

  // Pass 2: decorators (NestJS-style) — walk all class declarations + methods
  collectDecorators(sourceFile, decorators);

  // Methods
  const hasImport = (specifier: string, fromSource?: string): boolean => {
    for (const imp of imports) {
      if (fromSource && imp.source !== fromSource) continue;
      if (
        imp.specifiers.includes(specifier) ||
        imp.defaultImport === specifier ||
        imp.namespaceImport === specifier
      ) {
        return true;
      }
    }
    return false;
  };

  const findCalls = (name: string): ParsedCallSite[] => {
    const results: ParsedCallSite[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node.expression);
        if (callee === name) {
          results.push({
            callee,
            line: getLine(sourceFile, node),
            args: node.arguments.map((a) => parseArg(a)),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return results;
  };

  const findCallsWithStringArg = (name: string) => {
    return findCalls(name)
      .filter((c) => c.args[0]?.kind === "string" && c.args[0]?.value !== undefined)
      .map((c) => ({ ...c, stringArg: c.args[0].value as string }));
  };

  const containingFunction = (line: number): string | null => {
    let result: string | null = null;
    let resultLine = -1;
    const visit = (node: ts.Node) => {
      const nodeStartLine = getLine(sourceFile, node);
      const nodeEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (nodeStartLine <= line && line <= nodeEnd) {
        // Function-like declaration whose range contains the target line — record its name.
        const name = functionLikeName(node);
        if (name && nodeStartLine > resultLine) {
          result = name;
          resultLine = nodeStartLine;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
  };

  const findDecoratorsByName = (name: string): ParsedDecorator[] =>
    decorators.filter((d) => d.name === name);

  return {
    filePath,
    sourceFile,
    imports,
    fileDirectives,
    exports,
    decorators,
    hasImport,
    findCalls,
    findCallsWithStringArg,
    containingFunction,
    findDecoratorsByName,
  };
}

// ─── Implementation helpers ────────────────────────────────────────────────

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":  return ts.ScriptKind.JS;
    default:     return ts.ScriptKind.TS;
  }
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isLeadingDirective(sourceFile: ts.SourceFile, stmt: ts.Statement): boolean {
  // A directive must be among the FIRST statements of the file, all of which are
  // string-literal expression statements (Prologue Directives, per ECMA-262).
  for (const s of sourceFile.statements) {
    if (s === stmt) return true;
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
  }
  return false;
}

function isFunctionBodyDirective(stmt: ts.Statement | undefined): string | undefined {
  if (!stmt) return undefined;
  if (!ts.isExpressionStatement(stmt)) return undefined;
  if (!ts.isStringLiteral(stmt.expression)) return undefined;
  return stmt.expression.text;
}

function parseImport(sourceFile: ts.SourceFile, decl: ts.ImportDeclaration): ParsedImport | null {
  if (!ts.isStringLiteral(decl.moduleSpecifier)) return null;
  const source = decl.moduleSpecifier.text;
  const line = getLine(sourceFile, decl);
  const result: ParsedImport = { source, specifiers: [], line };

  const clause = decl.importClause;
  if (!clause) {
    // Side-effect import: `import "foo"` — no specifiers
    return result;
  }
  if (clause.name) {
    result.defaultImport = clause.name.text;
  }
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      result.namespaceImport = clause.namedBindings.name.text;
    } else if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        result.specifiers.push(el.name.text);
      }
    }
  }
  return result;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (node as any).modifiers as ts.NodeArray<ts.Modifier> | undefined;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.Node): boolean {
  const modifiers = (node as any).modifiers as ts.NodeArray<ts.Modifier> | undefined;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = (node as any).modifiers as ts.NodeArray<ts.Modifier> | undefined;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function parseExport(sourceFile: ts.SourceFile, stmt: ts.Statement): ParsedExport | null {
  // export function foo() { ... }
  if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt) && stmt.name) {
    const bodyDirective = stmt.body ? isFunctionBodyDirective(stmt.body.statements[0]) : undefined;
    return {
      name: stmt.name.text,
      line: getLine(sourceFile, stmt),
      kind: hasAsyncModifier(stmt) ? "asyncFunction" : "function",
      bodyDirective,
    };
  }
  // export default function foo() {} | export default <expr>
  if (ts.isFunctionDeclaration(stmt) && hasDefaultModifier(stmt)) {
    const bodyDirective = stmt.body ? isFunctionBodyDirective(stmt.body.statements[0]) : undefined;
    return {
      name: stmt.name ? stmt.name.text : "default",
      line: getLine(sourceFile, stmt),
      kind: "default",
      bodyDirective,
    };
  }
  if (ts.isExportAssignment(stmt)) {
    return {
      name: "default",
      line: getLine(sourceFile, stmt),
      kind: "default",
    };
  }
  // export class Foo {}
  if (ts.isClassDeclaration(stmt) && hasExportModifier(stmt) && stmt.name) {
    return { name: stmt.name.text, line: getLine(sourceFile, stmt), kind: "class" };
  }
  // export interface Foo {}
  if (ts.isInterfaceDeclaration(stmt) && hasExportModifier(stmt)) {
    return { name: stmt.name.text, line: getLine(sourceFile, stmt), kind: "interface" };
  }
  // export type Foo = ...
  if (ts.isTypeAliasDeclaration(stmt) && hasExportModifier(stmt)) {
    return { name: stmt.name.text, line: getLine(sourceFile, stmt), kind: "type" };
  }
  // export * from "..." | export { foo } from "..."
  if (ts.isExportDeclaration(stmt)) {
    // We surface re-exports as exports too, named when possible.
    if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      // Return the first one — multi-symbol re-exports are uncommon and adapters rarely need them.
      // For full coverage, callers can iterate sourceFile.statements directly.
      const first = stmt.exportClause.elements[0];
      if (first) {
        return { name: first.name.text, line: getLine(sourceFile, stmt), kind: "reExport" };
      }
    }
    return { name: "*", line: getLine(sourceFile, stmt), kind: "reExport" };
  }
  // export const foo = ... | export const foo = () => ... | export const foo = async () => ... | export const foo = something()
  if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length === 0 || !decls[0].name || !ts.isIdentifier(decls[0].name)) return null;
    const decl = decls[0];
    const name = (decl.name as ts.Identifier).text;
    const line = getLine(sourceFile, stmt);
    if (decl.initializer) {
      // const foo = async () => { ... }
      if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
        const async = decl.initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
        const bodyStmts = ts.isBlock(decl.initializer.body) ? decl.initializer.body.statements : [];
        const bodyDirective = isFunctionBodyDirective(bodyStmts[0]);
        return {
          name,
          line,
          kind: async ? "constAsyncArrow" : "constArrow",
          bodyDirective,
        };
      }
      // const foo = pgTable(...)
      if (ts.isCallExpression(decl.initializer)) {
        return {
          name,
          line,
          kind: "const",
          initializerCall: {
            callee: calleeName(decl.initializer.expression),
            args: decl.initializer.arguments.map((a) => parseArg(a)),
          },
        };
      }
    }
    return { name, line, kind: "const" };
  }
  return null;
}

function calleeName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  // For computed accesses or complex callees, return empty string.
  return "";
}

function parseArg(arg: ts.Expression): ParsedArg {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { kind: "string", value: arg.text };
  }
  if (ts.isNumericLiteral(arg)) {
    return { kind: "number", value: arg.text };
  }
  if (arg.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolean", value: "true" };
  }
  if (arg.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: "false" };
  }
  if (ts.isIdentifier(arg)) {
    return { kind: "identifier", value: arg.text };
  }
  if (ts.isObjectLiteralExpression(arg)) {
    const properties: Record<string, ParsedArg> = {};
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        properties[prop.name.text] = parseArg(prop.initializer);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        properties[prop.name.text] = { kind: "identifier", value: prop.name.text };
      }
    }
    return { kind: "object", properties };
  }
  if (ts.isArrayLiteralExpression(arg)) {
    return { kind: "array" };
  }
  return { kind: "other" };
}

function functionLikeName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return node.name.text;
    }
  }
  return null;
}

function collectDecorators(sourceFile: ts.SourceFile, results: ParsedDecorator[]): void {
  // Visit with a `currentClass` context so method/property decorators know their owner.
  const visit = (node: ts.Node, currentClass: string | undefined) => {
    let nextClassContext = currentClass;
    if (ts.isClassDeclaration(node) && node.name) {
      nextClassContext = node.name.text;
    }

    const decoratorsArr = ts.getDecorators?.(node as any) as readonly ts.Decorator[] | undefined;
    if (decoratorsArr && decoratorsArr.length > 0) {
      let appliedTo: ParsedDecorator["appliedTo"] | null = null;
      if (ts.isClassDeclaration(node) && node.name) {
        appliedTo = { kind: "class", name: node.name.text, line: getLine(sourceFile, node) };
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        appliedTo = {
          kind: "method",
          name: node.name.text,
          line: getLine(sourceFile, node),
          parentClass: currentClass,
        };
      } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        appliedTo = {
          kind: "property",
          name: node.name.text,
          line: getLine(sourceFile, node),
          parentClass: currentClass,
        };
      }
      if (appliedTo) {
        for (const dec of decoratorsArr) {
          const parsed = parseDecorator(sourceFile, dec, appliedTo);
          if (parsed) results.push(parsed);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextClassContext));
  };
  visit(sourceFile, undefined);
}

function parseDecorator(sourceFile: ts.SourceFile, dec: ts.Decorator, appliedTo: ParsedDecorator["appliedTo"]): ParsedDecorator | null {
  const expr = dec.expression;
  let name = "";
  let args: ParsedArg[] = [];
  if (ts.isCallExpression(expr)) {
    name = calleeName(expr.expression);
    args = expr.arguments.map((a) => parseArg(a));
  } else if (ts.isIdentifier(expr)) {
    name = expr.text;
  } else {
    return null;
  }
  return { name, line: getLine(sourceFile, dec), args, appliedTo };
}
