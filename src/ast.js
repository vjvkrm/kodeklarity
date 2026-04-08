import fs from "node:fs/promises";
import ts from "typescript";

export function getSourceLineNumber(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return position.line + 1;
}

export function hasModifier(node, modifierKind) {
  const modifiers = node.modifiers ? Array.from(node.modifiers) : [];
  return modifiers.some((modifier) => modifier.kind === modifierKind);
}

export function collectFunctionLikeDeclarations(sourceFile) {
  const declarations = new Map();
  const classSymbols = new Set();
  let defaultSymbol = null;

  function register(symbol, node, metadata = {}) {
    if (typeof symbol !== "string" || !symbol.trim()) {
      return;
    }

    const entry = {
      node,
      start_line: getSourceLineNumber(sourceFile, node),
      class_symbol: metadata.class_symbol || null,
      qualified_symbol: metadata.qualified_symbol || null,
    };

    const bucket = declarations.get(symbol) || [];
    bucket.push(entry);
    declarations.set(symbol, bucket);
  }

  function registerClassMethod(classSymbol, methodSymbol, node) {
    if (typeof classSymbol !== "string" || !classSymbol.trim()) {
      return;
    }
    if (typeof methodSymbol !== "string" || !methodSymbol.trim()) {
      return;
    }

    classSymbols.add(classSymbol);
    register(methodSymbol, node, {
      class_symbol: classSymbol,
      qualified_symbol: `${classSymbol}.${methodSymbol}`,
    });
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        register(node.name.text, node);
        if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
          defaultSymbol = node.name.text;
        }
      } else if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
        const syntheticDefaultSymbol = "__default_export__";
        register(syntheticDefaultSymbol, node);
        defaultSymbol = syntheticDefaultSymbol;
      }
    } else if (ts.isClassDeclaration(node)) {
      const classSymbol =
        node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : hasModifier(node, ts.SyntaxKind.DefaultKeyword)
            ? "__default_class__"
            : null;

      if (classSymbol) {
        classSymbols.add(classSymbol);
        register(classSymbol, node, {
          class_symbol: classSymbol,
          qualified_symbol: classSymbol,
        });
        if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
          defaultSymbol = classSymbol;
        }
      }

      for (const member of node.members) {
        if (!classSymbol) {
          continue;
        }

        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          registerClassMethod(classSymbol, member.name.text, member);
        } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
          const initializer = member.initializer;
          if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
            registerClassMethod(classSymbol, member.name.text, initializer);
          }
        }
      }

      for (const member of node.members) {
        ts.forEachChild(member, visit);
      }
      return;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      register(node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        register(node.name.text, initializer);
      }
    } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      defaultSymbol = node.expression.text;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    declarations,
    default_symbol: defaultSymbol,
    class_symbols: classSymbols,
  };
}

export function collectImportBindings(sourceFile) {
  const bindings = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }

    if (importClause.name && ts.isIdentifier(importClause.name)) {
      bindings.set(importClause.name.text, {
        kind: "default",
        imported_symbol: "default",
        module_specifier: moduleSpecifier,
      });
    }

    const namedBindings = importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(namedBindings) && ts.isIdentifier(namedBindings.name)) {
      bindings.set(namedBindings.name.text, {
        kind: "namespace",
        imported_symbol: "*",
        module_specifier: moduleSpecifier,
      });
      continue;
    }

    if (!ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const element of namedBindings.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }

      const importedSymbol =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;

      bindings.set(element.name.text, {
        kind: "named",
        imported_symbol: importedSymbol,
        module_specifier: moduleSpecifier,
      });
    }
  }

  return bindings;
}

export function collectExportBindings(sourceFile) {
  const localExports = new Map();
  const reExportNamed = [];
  const reExportAll = [];

  function registerLocalExport(exportedSymbol, localSymbol) {
    if (typeof exportedSymbol !== "string" || !exportedSymbol.trim()) {
      return;
    }
    if (typeof localSymbol !== "string" || !localSymbol.trim()) {
      return;
    }

    localExports.set(exportedSymbol, localSymbol);
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && ts.isIdentifier(statement.name)) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        registerLocalExport(statement.name.text, statement.name.text);
      }
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        registerLocalExport("default", statement.name.text);
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name && ts.isIdentifier(statement.name)) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        registerLocalExport(statement.name.text, statement.name.text);
      }
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        registerLocalExport("default", statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }
        registerLocalExport(declaration.name.text, declaration.name.text);
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      registerLocalExport("default", statement.expression.text);
      continue;
    }

    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;

    if (!statement.exportClause) {
      if (moduleSpecifier) {
        reExportAll.push({
          module_specifier: moduleSpecifier,
        });
      }
      continue;
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }

      const exportedSymbol = element.name.text;
      const importedSymbol =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;

      if (moduleSpecifier) {
        reExportNamed.push({
          exported_symbol: exportedSymbol,
          imported_symbol: importedSymbol,
          module_specifier: moduleSpecifier,
        });
      } else {
        registerLocalExport(exportedSymbol, importedSymbol);
      }
    }
  }

  return {
    local_exports: localExports,
    re_export_named: reExportNamed,
    re_export_all: reExportAll,
  };
}

export function collectSymbolsFromSource(sourceFile) {
  const symbols = new Set();

  function visit(node) {
    if (ts.isIdentifier(node)) {
      symbols.add(node.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return symbols;
}

export async function loadFileAstInfo(absFilePath, cache) {
  const cached = cache.get(absFilePath);
  if (cached) {
    return cached;
  }

  const text = await fs.readFile(absFilePath, "utf8");
  const sourceFile = ts.createSourceFile(absFilePath, text, ts.ScriptTarget.Latest, true);
  const lines = text.split(/\r?\n/);
  const symbols = collectSymbolsFromSource(sourceFile);

  const info = {
    line_count: lines.length,
    symbols,
  };

  cache.set(absFilePath, info);
  return info;
}

export function pickBestDeclaration(declarations, symbol, lineHint, classHint = null) {
  const allCandidates = declarations.get(symbol);
  const candidates =
    typeof classHint === "string" && classHint.trim()
      ? (allCandidates || []).filter((candidate) => candidate.class_symbol === classHint)
      : allCandidates;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  if (!Number.isInteger(lineHint) || lineHint < 1) {
    return candidates[0];
  }

  let best = candidates[0];
  let bestDistance = Math.abs(best.start_line - lineHint);

  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(candidate.start_line - lineHint);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

export function extractTypeReferenceSymbol(typeNode) {
  if (!typeNode) {
    return null;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    if (ts.isIdentifier(typeNode.typeName)) {
      return typeNode.typeName.text;
    }

    if (ts.isQualifiedName(typeNode.typeName) && ts.isIdentifier(typeNode.typeName.right)) {
      return typeNode.typeName.right.text;
    }
  }

  return null;
}

export function extractClassSymbolFromExpression(expression) {
  if (!expression) {
    return null;
  }

  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return expression.name.text;
  }

  return null;
}

export function extractTypeHintFromTypedNode(node, knownTypeHints) {
  const fromTypeAnnotation = extractTypeReferenceSymbol(node.type);
  if (fromTypeAnnotation) {
    return fromTypeAnnotation;
  }

  if (node.initializer && ts.isNewExpression(node.initializer)) {
    return extractClassSymbolFromExpression(node.initializer.expression);
  }

  if (node.initializer && ts.isIdentifier(node.initializer)) {
    return knownTypeHints.get(node.initializer.text)?.class_symbol || null;
  }

  return null;
}

export function collectModuleTypeHints(sourceFile, imports) {
  const moduleTypeHints = new Map();

  function registerHint(localName, classSymbol) {
    if (typeof localName !== "string" || !localName.trim()) {
      return;
    }
    if (typeof classSymbol !== "string" || !classSymbol.trim()) {
      return;
    }

    moduleTypeHints.set(localName, {
      class_symbol: classSymbol,
      class_import_binding: imports.get(classSymbol) || null,
    });
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
        continue;
      }

      const classSymbol = extractTypeHintFromTypedNode(declaration, moduleTypeHints);
      if (classSymbol) {
        registerHint(declaration.name.text, classSymbol);
      }
    }
  }

  return moduleTypeHints;
}

export function collectTypeHintsForDeclaration(declarationEntry, imports, moduleTypeHints = null) {
  const localTypeHints = new Map(moduleTypeHints ? Array.from(moduleTypeHints.entries()) : []);
  const thisPropertyTypeHints = new Map();

  function registerLocalHint(localName, classSymbol) {
    if (typeof localName !== "string" || !localName.trim()) {
      return;
    }
    if (typeof classSymbol !== "string" || !classSymbol.trim()) {
      return;
    }

    localTypeHints.set(localName, {
      class_symbol: classSymbol,
      class_import_binding: imports.get(classSymbol) || null,
    });
  }

  const declarationNode = declarationEntry.node;

  if (Array.isArray(declarationNode.parameters)) {
    for (const parameter of declarationNode.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        continue;
      }

      const classSymbol = extractTypeHintFromTypedNode(parameter, localTypeHints);
      if (classSymbol) {
        registerLocalHint(parameter.name.text, classSymbol);
      }
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const classSymbol = extractTypeHintFromTypedNode(node, localTypeHints);
      if (classSymbol) {
        registerLocalHint(node.name.text, classSymbol);
      }
    }

    ts.forEachChild(node, visit);
  }

  const bodyNode = declarationNode.body || declarationNode;
  ts.forEachChild(bodyNode, visit);

  if (declarationEntry.class_symbol && declarationNode.parent && declarationNode.parent.parent) {
    const classNode = ts.isClassElement(declarationNode.parent)
      ? declarationNode.parent.parent
      : declarationNode.parent;

    if (classNode && ts.isClassDeclaration(classNode)) {
      for (const member of classNode.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) {
          continue;
        }

        const classSymbol = extractTypeHintFromTypedNode(member, localTypeHints);
        if (!classSymbol) {
          continue;
        }

        thisPropertyTypeHints.set(member.name.text, {
          class_symbol: classSymbol,
          class_import_binding: imports.get(classSymbol) || null,
        });
      }
    }
  }

  return {
    local_type_hints: localTypeHints,
    this_property_type_hints: thisPropertyTypeHints,
  };
}

export function collectCallSitesFromDeclaration(declarationEntry, sourceFile, imports, moduleTypeHints) {
  const calls = [];
  const declarationNode = declarationEntry.node;
  const typeHints = collectTypeHintsForDeclaration(declarationEntry, imports, moduleTypeHints);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const position = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));

      if (ts.isIdentifier(expression)) {
        const localSymbol = expression.text.trim();
        if (!localSymbol) {
          return;
        }

        calls.push({
          symbol: localSymbol,
          local_symbol: localSymbol,
          line: position.line + 1,
          column: position.character + 1,
          import_binding: imports.get(localSymbol) || null,
          call_kind: "identifier",
        });
      } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
        const calledSymbol = expression.name.text.trim();
        if (!calledSymbol) {
          return;
        }

        let importBinding = null;
        let receiverSymbol = null;
        let receiverTypeHint = null;
        if (ts.isIdentifier(expression.expression)) {
          receiverSymbol = expression.expression.text;
          const receiverImportBinding = imports.get(receiverSymbol) || null;
          if (receiverImportBinding && receiverImportBinding.kind === "namespace") {
            importBinding = {
              ...receiverImportBinding,
              imported_symbol: calledSymbol,
            };
          }

          receiverTypeHint = typeHints.local_type_hints.get(receiverSymbol) || null;
        } else if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          receiverSymbol = "this";
          if (declarationEntry.class_symbol) {
            receiverTypeHint = {
              class_symbol: declarationEntry.class_symbol,
              class_import_binding: null,
            };
          }
        } else if (
          ts.isPropertyAccessExpression(expression.expression) &&
          expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(expression.expression.name)
        ) {
          receiverSymbol = `this.${expression.expression.name.text}`;
          receiverTypeHint = typeHints.this_property_type_hints.get(expression.expression.name.text) || null;
        }

        calls.push({
          symbol: calledSymbol,
          local_symbol: calledSymbol,
          line: position.line + 1,
          column: position.character + 1,
          receiver_symbol: receiverSymbol,
          receiver_type_hint: receiverTypeHint,
          import_binding: importBinding,
          call_kind: "property_access",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  const bodyNode = declarationNode.body || declarationNode;
  ts.forEachChild(bodyNode, visit);

  return calls;
}
