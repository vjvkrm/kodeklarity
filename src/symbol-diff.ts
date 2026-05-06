import ts from "typescript";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type SymbolChangeVerdict =
  | "unchanged"          // declaration text identical at both refs
  | "body_changed"       // body differs but the signature line is identical
  | "signature_changed"  // declaration line differs (params/return type/exported identity)
  | "removed_or_renamed" // present at base, absent at head
  | "added"              // absent at base, present at head
  | "unknown";           // couldn't extract (e.g. dynamic export, file unparseable)

interface SymbolDeclaration {
  name: string;
  text: string;            // full declaration text (raw, for debugging)
  normalizedText: string;  // collapsed-whitespace text for diff comparison
  signature: string;       // normalized header before the body opener
}

/** Collapse all whitespace runs to a single space and trim. Removes line-number
 *  shifts and reformatting noise from the comparison without losing semantics. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extract a map of top-level exported symbols → declaration text from a source string.
 * Recognizes function declarations, class declarations, and exported `const` / `let`
 * bindings (so React components and zustand stores are covered).
 */
function extractSymbols(content: string, filename: string): Map<string, SymbolDeclaration> {
  const map = new Map<string, SymbolDeclaration>();
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, scriptKindFor(filename));
  } catch {
    return map;
  }

  const record = (name: string, fullText: string) => {
    if (map.has(name)) return; // first-declaration wins (handles overloads)
    map.set(name, {
      name,
      text: fullText,
      normalizedText: normalizeWhitespace(fullText),
      signature: normalizeWhitespace(extractSignature(fullText)),
    });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      record(stmt.name.text, stmt.getText(sf));
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      record(stmt.name.text, stmt.getText(sf));
    } else if (ts.isVariableStatement(stmt)) {
      // covers: export const foo = ..., export let bar = ...
      const stmtText = stmt.getText(sf);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          record(decl.name.text, stmtText);
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      // export default <expr>; — record under "default" so we can compare
      record("default", stmt.getText(sf));
    }
  }
  return map;
}

function scriptKindFor(filename: string): ts.ScriptKind {
  if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filename.endsWith(".js") || filename.endsWith(".mjs") || filename.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Extract the signature substring from a declaration's full text — everything
 * before the body opener (`{` for function/class, `=>` for arrow expressions, `=` for var
 * initialisers). Whitespace and trailing semicolons are normalized.
 */
function extractSignature(fullText: string): string {
  const candidates = [fullText.indexOf("{"), fullText.indexOf("=>"), fullText.indexOf("=")];
  const positions = candidates.filter((i) => i >= 0);
  const cutoff = positions.length > 0 ? Math.min(...positions) : fullText.length;
  return fullText
    .slice(0, cutoff)
    .replace(/\s+/g, " ")
    .trim();
}

function readFromGit(cwd: string, ref: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null; // file didn't exist at that ref
  }
}

function readFromDisk(cwd: string, file: string): string | null {
  try {
    return fs.readFileSync(path.resolve(cwd, file), "utf8");
  } catch {
    return null; // file deleted or unreadable
  }
}

// Cache uses null as a sentinel for "file did not exist at this ref".
const fileCache = new Map<string, Map<string, SymbolDeclaration> | null>();

/**
 * Classify per-symbol changes for a single file across two refs.
 *
 * @param baseRef git ref to compare against (e.g. merge-base SHA, "HEAD")
 * @returns map: symbol name -> verdict
 */
export function classifyFileSymbols(
  cwd: string,
  baseRef: string,
  file: string,
  symbolNames: string[],
): Map<string, SymbolChangeVerdict> {
  const result = new Map<string, SymbolChangeVerdict>();

  const oldKey = `${baseRef}::${file}`;
  let oldMap: Map<string, SymbolDeclaration> | null;
  if (fileCache.has(oldKey)) {
    oldMap = fileCache.get(oldKey) ?? null;
  } else {
    const oldContent = readFromGit(cwd, baseRef, file);
    oldMap = oldContent === null ? null : extractSymbols(oldContent, file);
    fileCache.set(oldKey, oldMap);
  }

  const newKey = `WORKING::${file}`;
  let newMap: Map<string, SymbolDeclaration> | null;
  if (fileCache.has(newKey)) {
    newMap = fileCache.get(newKey) ?? null;
  } else {
    const newContent = readFromDisk(cwd, file);
    newMap = newContent === null ? null : extractSymbols(newContent, file);
    fileCache.set(newKey, newMap);
  }

  // File deleted entirely
  if (newMap === null) {
    for (const name of symbolNames) result.set(name, "removed_or_renamed");
    return result;
  }
  // File didn't exist at base (whole-file addition)
  if (oldMap === null) {
    for (const name of symbolNames) result.set(name, "added");
    return result;
  }

  for (const name of symbolNames) {
    const oldDecl = oldMap.get(name);
    const newDecl = newMap.get(name);

    if (!oldDecl && !newDecl) {
      // Symbol isn't a top-level declaration we recognize (re-export, namespaced, etc.).
      // We can't classify it — be conservative.
      result.set(name, "unknown");
    } else if (!oldDecl) {
      result.set(name, "added");
    } else if (!newDecl) {
      result.set(name, "removed_or_renamed");
    } else if (oldDecl.normalizedText === newDecl.normalizedText) {
      result.set(name, "unchanged");
    } else if (oldDecl.signature !== newDecl.signature) {
      result.set(name, "signature_changed");
    } else {
      result.set(name, "body_changed");
    }
  }

  return result;
}

/** Clear the per-call cache. Call once at the start of each review-graph run. */
export function resetSymbolDiffCache(): void {
  fileCache.clear();
}
