import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { isObject, readJsonFileLoose } from "./utils.js";
import {
  collectFunctionLikeDeclarations,
  collectImportBindings,
  collectExportBindings,
  collectModuleTypeHints,
  pickBestDeclaration,
} from "./ast.js";

export function parsePathAliasMappings(compilerOptionsRaw, baseDir) {
  const mappings = [];
  if (!isObject(compilerOptionsRaw)) {
    return mappings;
  }

  const paths = isObject(compilerOptionsRaw.paths) ? compilerOptionsRaw.paths : {};
  for (const [aliasPattern, targetValues] of Object.entries(paths)) {
    if (typeof aliasPattern !== "string" || !aliasPattern.trim()) {
      continue;
    }

    if (!Array.isArray(targetValues)) {
      continue;
    }

    for (const targetPattern of targetValues) {
      if (typeof targetPattern !== "string" || !targetPattern.trim()) {
        continue;
      }

      mappings.push({
        alias_pattern: aliasPattern.trim(),
        target_pattern: targetPattern.trim(),
        base_dir: baseDir,
      });
    }
  }

  return mappings;
}

export function matchAliasPattern(aliasPattern, moduleSpecifier) {
  if (!aliasPattern.includes("*")) {
    return aliasPattern === moduleSpecifier ? "" : null;
  }

  const starIndex = aliasPattern.indexOf("*");
  const prefix = aliasPattern.slice(0, starIndex);
  const suffix = aliasPattern.slice(starIndex + 1);

  if (!moduleSpecifier.startsWith(prefix)) {
    return null;
  }
  if (!moduleSpecifier.endsWith(suffix)) {
    return null;
  }

  const middle = moduleSpecifier.slice(prefix.length, moduleSpecifier.length - suffix.length);
  return middle;
}

export function replaceAliasTarget(targetPattern, wildcardValue) {
  if (!targetPattern.includes("*")) {
    return targetPattern;
  }

  return targetPattern.replace("*", wildcardValue ?? "");
}

export function isPathInsideDirectory(absPath, absDirectoryPath) {
  if (typeof absPath !== "string" || !absPath.trim()) {
    return false;
  }

  if (typeof absDirectoryPath !== "string" || !absDirectoryPath.trim()) {
    return false;
  }

  const relativePath = path.relative(absDirectoryPath, absPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function getTsConfigResolverEntries(aliasResolver) {
  if (!isObject(aliasResolver)) {
    return [];
  }

  return Array.isArray(aliasResolver.tsconfig_entries) ? aliasResolver.tsconfig_entries : [];
}

export function getAliasResolverScope(aliasResolver) {
  if (typeof aliasResolver?.resolver_scope === "string" && aliasResolver.resolver_scope.trim()) {
    return aliasResolver.resolver_scope.trim();
  }

  if (typeof aliasResolver?.tsconfig_path === "string" && aliasResolver.tsconfig_path.trim()) {
    return aliasResolver.tsconfig_path.trim();
  }

  return null;
}

export function selectTsConfigResolverEntries(aliasResolver, fromAbsFilePath) {
  const entries = getTsConfigResolverEntries(aliasResolver);
  if (entries.length === 0) {
    return [];
  }

  const normalizedFilePath = path.normalize(fromAbsFilePath);
  const matchingEntries = entries.filter((entry) =>
    isPathInsideDirectory(normalizedFilePath, entry.config_dir)
  );

  return matchingEntries.length > 0 ? matchingEntries : entries;
}

export function buildImportResolutionCandidateBases(fromAbsFilePath, moduleSpecifier, aliasResolver) {
  const normalizedSpecifier = typeof moduleSpecifier === "string" ? moduleSpecifier.trim() : "";
  if (!normalizedSpecifier) {
    return [];
  }

  if (normalizedSpecifier.startsWith(".")) {
    return [
      {
        unresolved_target: path.resolve(path.dirname(fromAbsFilePath), normalizedSpecifier),
        resolved_by_tsconfig: null,
        resolution_kind: "relative",
      },
    ];
  }

  const candidateBases = [];
  const resolverEntries = selectTsConfigResolverEntries(aliasResolver, fromAbsFilePath);
  for (const resolverEntry of resolverEntries) {
    const aliasMappings = Array.isArray(resolverEntry.alias_mappings) ? resolverEntry.alias_mappings : [];
    for (const mapping of aliasMappings) {
      const wildcardValue = matchAliasPattern(mapping.alias_pattern, normalizedSpecifier);
      if (wildcardValue === null) {
        continue;
      }

      const targetPath = replaceAliasTarget(mapping.target_pattern, wildcardValue);
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        continue;
      }

      const baseDir =
        typeof mapping.base_dir === "string" && mapping.base_dir.trim()
          ? mapping.base_dir
          : resolverEntry.base_url_abs;
      if (typeof baseDir !== "string" || !baseDir.trim()) {
        continue;
      }
      candidateBases.push({
        unresolved_target: path.resolve(baseDir, targetPath),
        resolved_by_tsconfig:
          typeof resolverEntry.tsconfig_path === "string" && resolverEntry.tsconfig_path.trim()
            ? resolverEntry.tsconfig_path
            : null,
        resolution_kind: "alias_path",
      });
    }

    if (typeof resolverEntry.base_url_abs === "string" && resolverEntry.base_url_abs.trim()) {
      candidateBases.push({
        unresolved_target: path.resolve(resolverEntry.base_url_abs, normalizedSpecifier),
        resolved_by_tsconfig:
          typeof resolverEntry.tsconfig_path === "string" && resolverEntry.tsconfig_path.trim()
            ? resolverEntry.tsconfig_path
            : null,
        resolution_kind: "base_url",
      });
    }
  }

  const uniqueBases = [];
  const seenBases = new Set();
  for (const candidate of candidateBases) {
    const unresolvedTarget = typeof candidate?.unresolved_target === "string" ? candidate.unresolved_target : "";
    if (!unresolvedTarget.trim()) {
      continue;
    }

    const normalized = path.normalize(unresolvedTarget);
    if (seenBases.has(normalized)) {
      continue;
    }

    seenBases.add(normalized);
    uniqueBases.push({
      unresolved_target: normalized,
      resolved_by_tsconfig:
        typeof candidate.resolved_by_tsconfig === "string" && candidate.resolved_by_tsconfig.trim()
          ? candidate.resolved_by_tsconfig
          : null,
      resolution_kind:
        typeof candidate.resolution_kind === "string" && candidate.resolution_kind.trim()
          ? candidate.resolution_kind
          : "unknown",
    });
  }

  return uniqueBases;
}

export function buildImportResolutionFileCandidates(unresolvedTarget) {
  const explicitExtension = path.extname(unresolvedTarget).toLowerCase();
  const hasExplicitExtension = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"].includes(
    explicitExtension
  );

  if (hasExplicitExtension) {
    return [unresolvedTarget];
  }

  return [
    `${unresolvedTarget}.ts`,
    `${unresolvedTarget}.tsx`,
    `${unresolvedTarget}.mts`,
    `${unresolvedTarget}.cts`,
    `${unresolvedTarget}.js`,
    `${unresolvedTarget}.mjs`,
    path.join(unresolvedTarget, "index.ts"),
    path.join(unresolvedTarget, "index.tsx"),
    path.join(unresolvedTarget, "index.mts"),
    path.join(unresolvedTarget, "index.cts"),
    path.join(unresolvedTarget, "index.js"),
    path.join(unresolvedTarget, "index.mjs"),
  ];
}

export function resolveCompilerBaseUrlAbs(compilerOptions, tsConfigPath) {
  const tsConfigDir = path.dirname(tsConfigPath);
  const baseUrlRaw =
    typeof compilerOptions?.baseUrl === "string" && compilerOptions.baseUrl.trim()
      ? compilerOptions.baseUrl.trim()
      : null;

  if (!baseUrlRaw) {
    return path.normalize(tsConfigDir);
  }

  return path.normalize(path.isAbsolute(baseUrlRaw) ? baseUrlRaw : path.resolve(tsConfigDir, baseUrlRaw));
}

export async function resolveProjectReferenceTsConfigPath(referencePathValue, tsConfigPath) {
  if (typeof referencePathValue !== "string" || !referencePathValue.trim()) {
    return null;
  }

  const tsConfigDir = path.dirname(tsConfigPath);
  const resolvedReferencePath = path.resolve(tsConfigDir, referencePathValue.trim());
  const candidates = [];
  const extension = path.extname(resolvedReferencePath).toLowerCase();

  if (extension === ".json") {
    candidates.push(resolvedReferencePath);
  } else {
    candidates.push(resolvedReferencePath);
    candidates.push(path.join(resolvedReferencePath, "tsconfig.json"));
    candidates.push(`${resolvedReferencePath}.json`);
  }

  const seenCandidates = new Set();
  for (const candidatePath of candidates) {
    const normalizedCandidatePath = path.normalize(candidatePath);
    if (seenCandidates.has(normalizedCandidatePath)) {
      continue;
    }

    seenCandidates.add(normalizedCandidatePath);

    try {
      const stat = await fs.stat(normalizedCandidatePath);
      if (stat.isFile()) {
        return normalizedCandidatePath;
      }
    } catch {
      // Keep probing reference candidates.
    }
  }

  return null;
}

export async function collectProjectReferenceTsConfigPaths(rawTsConfig, tsConfigPath) {
  const references = Array.isArray(rawTsConfig?.references) ? rawTsConfig.references : [];
  const referenceConfigPaths = [];
  const seen = new Set();

  for (const reference of references) {
    if (!isObject(reference) || typeof reference.path !== "string") {
      continue;
    }

    const resolvedReferencePath = await resolveProjectReferenceTsConfigPath(reference.path, tsConfigPath);
    if (!resolvedReferencePath || seen.has(resolvedReferencePath)) {
      continue;
    }

    seen.add(resolvedReferencePath);
    referenceConfigPaths.push(resolvedReferencePath);
  }

  return referenceConfigPaths;
}

export async function loadSingleTsConfigResolver(tsConfigPath) {
  const normalizedTsConfigPath = path.normalize(tsConfigPath);
  let rawTsConfig;
  try {
    rawTsConfig = await readJsonFileLoose(normalizedTsConfigPath);
  } catch {
    return null;
  }

  const parsed = ts.parseJsonConfigFileContent(
    rawTsConfig,
    ts.sys,
    path.dirname(normalizedTsConfigPath),
    undefined,
    normalizedTsConfigPath
  );
  const compilerOptions = isObject(parsed?.options) ? parsed.options : {};
  const baseUrlAbs = resolveCompilerBaseUrlAbs(compilerOptions, normalizedTsConfigPath);
  const aliasMappings = parsePathAliasMappings(
    {
      paths: isObject(compilerOptions.paths) ? compilerOptions.paths : {},
    },
    baseUrlAbs
  );
  const referenceTsConfigPaths = await collectProjectReferenceTsConfigPaths(rawTsConfig, normalizedTsConfigPath);

  return {
    entry: {
      tsconfig_path: normalizedTsConfigPath,
      config_dir: path.dirname(normalizedTsConfigPath),
      base_url_abs: baseUrlAbs,
      alias_mappings: aliasMappings,
    },
    reference_tsconfig_paths: referenceTsConfigPaths,
  };
}

export async function loadTsConfigAliasResolver(repositoryRoot) {
  const rootTsConfigPath = path.normalize(path.resolve(repositoryRoot, "tsconfig.json"));
  try {
    const stat = await fs.stat(rootTsConfigPath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const queue = [rootTsConfigPath];
  const seenConfigPaths = new Set();
  const resolverEntries = [];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath || seenConfigPaths.has(currentPath)) {
      continue;
    }

    seenConfigPaths.add(currentPath);
    const loaded = await loadSingleTsConfigResolver(currentPath);
    if (!loaded) {
      continue;
    }

    resolverEntries.push(loaded.entry);
    for (const referencePath of loaded.reference_tsconfig_paths) {
      if (!seenConfigPaths.has(referencePath)) {
        queue.push(referencePath);
      }
    }
  }

  if (resolverEntries.length === 0) {
    return null;
  }

  resolverEntries.sort((left, right) => {
    const rightLength = typeof right.config_dir === "string" ? right.config_dir.length : 0;
    const leftLength = typeof left.config_dir === "string" ? left.config_dir.length : 0;
    return rightLength - leftLength;
  });

  return {
    repository_root: repositoryRoot,
    root_tsconfig_path: rootTsConfigPath,
    resolver_scope: resolverEntries.map((entry) => entry.tsconfig_path).join("|"),
    tsconfig_entries: resolverEntries,
  };
}

export async function resolveLocalImportFile(fromAbsFilePath, moduleSpecifier, resolutionCache, aliasResolver = null) {
  const normalizedSpecifier = typeof moduleSpecifier === "string" ? moduleSpecifier.trim() : "";
  if (!normalizedSpecifier) {
    return {
      resolved_abs_file_path: null,
      resolved_by_tsconfig: null,
      resolver_scope: getAliasResolverScope(aliasResolver),
      resolution_kind: "invalid_specifier",
      module_specifier: null,
    };
  }

  const resolverScope = getAliasResolverScope(aliasResolver) || "no_tsconfig_aliases";
  const cacheKey = `${fromAbsFilePath}::${normalizedSpecifier}::${resolverScope}`;
  if (resolutionCache.has(cacheKey)) {
    return resolutionCache.get(cacheKey);
  }

  const unresolvedCandidates = buildImportResolutionCandidateBases(fromAbsFilePath, normalizedSpecifier, aliasResolver);
  if (unresolvedCandidates.length === 0) {
    const unresolvedResult = {
      resolved_abs_file_path: null,
      resolved_by_tsconfig: null,
      resolver_scope: getAliasResolverScope(aliasResolver),
      resolution_kind: "no_resolution_candidates",
      module_specifier: normalizedSpecifier,
    };
    resolutionCache.set(cacheKey, unresolvedResult);
    return unresolvedResult;
  }

  let resolvedResult = null;
  const seenCandidates = new Set();
  for (const candidateEntry of unresolvedCandidates) {
    const unresolvedTarget = candidateEntry.unresolved_target;
    const candidates = buildImportResolutionFileCandidates(unresolvedTarget);
    for (const candidate of candidates) {
      const normalizedCandidate = path.normalize(candidate);
      if (seenCandidates.has(normalizedCandidate)) {
        continue;
      }

      seenCandidates.add(normalizedCandidate);

      try {
        const stat = await fs.stat(normalizedCandidate);
        if (stat.isFile()) {
          resolvedResult = {
            resolved_abs_file_path: normalizedCandidate,
            resolved_by_tsconfig: candidateEntry.resolved_by_tsconfig || null,
            resolver_scope: getAliasResolverScope(aliasResolver),
            resolution_kind: candidateEntry.resolution_kind || "unknown",
            module_specifier: normalizedSpecifier,
          };
          break;
        }
      } catch {
        // Keep probing candidates.
      }
    }

    if (resolvedResult) {
      break;
    }
  }

  if (!resolvedResult) {
    const firstCandidate = unresolvedCandidates[0];
    resolvedResult = {
      resolved_abs_file_path: null,
      resolved_by_tsconfig: firstCandidate?.resolved_by_tsconfig || null,
      resolver_scope: getAliasResolverScope(aliasResolver),
      resolution_kind: firstCandidate?.resolution_kind || "unresolved",
      module_specifier: normalizedSpecifier,
    };
  }

  resolutionCache.set(cacheKey, resolvedResult);
  return resolvedResult;
}

export async function loadAstExpansionFileInfo(absFilePath, cache) {
  const normalizedFilePath = path.normalize(absFilePath);
  const cached = cache.get(normalizedFilePath);
  if (cached) {
    return cached;
  }

  const text = await fs.readFile(normalizedFilePath, "utf8");
  const sourceFile = ts.createSourceFile(normalizedFilePath, text, ts.ScriptTarget.Latest, true);
  const declarationInfo = collectFunctionLikeDeclarations(sourceFile);
  const imports = collectImportBindings(sourceFile);
  const exports = collectExportBindings(sourceFile);
  const moduleTypeHints = collectModuleTypeHints(sourceFile, imports);

  const info = {
    abs_file_path: normalizedFilePath,
    sourceFile,
    declarations: declarationInfo.declarations,
    default_symbol: declarationInfo.default_symbol,
    class_symbols: declarationInfo.class_symbols,
    imports,
    exports,
    module_type_hints: moduleTypeHints,
  };

  cache.set(normalizedFilePath, info);
  return info;
}

export async function resolveExportedSymbol(
  absFilePath,
  exportedSymbol,
  astCache,
  resolutionCache,
  aliasResolver,
  visited = new Set()
) {
  const normalizedFilePath = path.normalize(absFilePath);
  const requestedSymbol =
    typeof exportedSymbol === "string" && exportedSymbol.trim() ? exportedSymbol.trim() : "default";
  const visitKey = `${normalizedFilePath}::${requestedSymbol}`;
  if (visited.has(visitKey)) {
    return null;
  }

  visited.add(visitKey);

  let fileInfo;
  try {
    fileInfo = await loadAstExpansionFileInfo(normalizedFilePath, astCache);
  } catch {
    return null;
  }

  const trySymbol = requestedSymbol === "default" ? fileInfo.default_symbol || "default" : requestedSymbol;
  if (typeof trySymbol === "string" && trySymbol.trim()) {
    const directDeclaration = pickBestDeclaration(fileInfo.declarations, trySymbol, undefined, null);
    if (directDeclaration) {
      return {
        target_abs_file_path: normalizedFilePath,
        target_symbol: trySymbol,
        target_class_symbol:
          directDeclaration.class_symbol ||
          (fileInfo.class_symbols?.has(trySymbol) ? trySymbol : null),
        target_declaration: directDeclaration,
        resolved_via: requestedSymbol === "default" ? "default_local_symbol" : "direct_export_symbol",
        resolved_by_tsconfig: null,
        resolver_scope: null,
      };
    }
  }

  const localAliasTarget = fileInfo.exports?.local_exports?.get(requestedSymbol);
  if (typeof localAliasTarget === "string" && localAliasTarget.trim()) {
    const aliasDeclaration = pickBestDeclaration(fileInfo.declarations, localAliasTarget, undefined, null);
    if (aliasDeclaration) {
      return {
        target_abs_file_path: normalizedFilePath,
        target_symbol: localAliasTarget,
        target_class_symbol:
          aliasDeclaration.class_symbol ||
          (fileInfo.class_symbols?.has(localAliasTarget) ? localAliasTarget : null),
        target_declaration: aliasDeclaration,
        resolved_via: "local_export_alias",
        resolved_by_tsconfig: null,
        resolver_scope: null,
      };
    }

    const importedAliasBinding = fileInfo.imports?.get(localAliasTarget) || null;
    if (importedAliasBinding && typeof importedAliasBinding.module_specifier === "string") {
      const importedAliasResolution = await resolveLocalImportFile(
        normalizedFilePath,
        importedAliasBinding.module_specifier,
        resolutionCache,
        aliasResolver
      );
      const importedAliasFile = importedAliasResolution.resolved_abs_file_path;
      if (importedAliasFile) {
        const aliasRequested =
          importedAliasBinding.kind === "default"
            ? "default"
            : importedAliasBinding.imported_symbol || localAliasTarget;
        const aliasResolution = await resolveExportedSymbol(
          importedAliasFile,
          aliasRequested,
          astCache,
          resolutionCache,
          aliasResolver,
          visited
        );
        if (aliasResolution) {
          return {
            ...aliasResolution,
            resolved_via: "local_alias_import_chain",
            resolved_by_tsconfig:
              aliasResolution.resolved_by_tsconfig || importedAliasResolution.resolved_by_tsconfig || null,
            resolver_scope: aliasResolution.resolver_scope || importedAliasResolution.resolver_scope || null,
          };
        }
      }
    }
  }

  const reExportNamed = Array.isArray(fileInfo.exports?.re_export_named) ? fileInfo.exports.re_export_named : [];
  for (const reExport of reExportNamed) {
    if (reExport.exported_symbol !== requestedSymbol) {
      continue;
    }

    const targetResolution = await resolveLocalImportFile(
      normalizedFilePath,
      reExport.module_specifier,
      resolutionCache,
      aliasResolver
    );
    const targetFile = targetResolution.resolved_abs_file_path;
    if (!targetFile) {
      continue;
    }

    const resolution = await resolveExportedSymbol(
      targetFile,
      reExport.imported_symbol,
      astCache,
      resolutionCache,
      aliasResolver,
      visited
    );
    if (resolution) {
      return {
        ...resolution,
        resolved_via: "re_export_named",
        resolved_by_tsconfig: resolution.resolved_by_tsconfig || targetResolution.resolved_by_tsconfig || null,
        resolver_scope: resolution.resolver_scope || targetResolution.resolver_scope || null,
      };
    }
  }

  const reExportAll = Array.isArray(fileInfo.exports?.re_export_all) ? fileInfo.exports.re_export_all : [];
  for (const reExport of reExportAll) {
    const targetResolution = await resolveLocalImportFile(
      normalizedFilePath,
      reExport.module_specifier,
      resolutionCache,
      aliasResolver
    );
    const targetFile = targetResolution.resolved_abs_file_path;
    if (!targetFile) {
      continue;
    }

    const resolution = await resolveExportedSymbol(
      targetFile,
      requestedSymbol,
      astCache,
      resolutionCache,
      aliasResolver,
      visited
    );
    if (resolution) {
      return {
        ...resolution,
        resolved_via: "re_export_all",
        resolved_by_tsconfig: resolution.resolved_by_tsconfig || targetResolution.resolved_by_tsconfig || null,
        resolver_scope: resolution.resolver_scope || targetResolution.resolver_scope || null,
      };
    }
  }

  return null;
}

export async function resolveCallTarget(callSite, currentFileInfo, astCache, resolutionCache, aliasResolver) {
  let targetAbsFilePath = currentFileInfo.abs_file_path;
  let targetSymbol = callSite.symbol;
  let targetClassSymbol = null;
  let targetDeclaration = null;
  let resolvedVia = "local";
  let resolvedModuleSpecifier = null;
  let resolvedByTsconfig = null;
  let resolverScope = getAliasResolverScope(aliasResolver);

  if (callSite.import_binding) {
    const importBinding = callSite.import_binding;
    resolvedModuleSpecifier = importBinding.module_specifier || null;
    const importResolution = await resolveLocalImportFile(
      currentFileInfo.abs_file_path,
      importBinding.module_specifier,
      resolutionCache,
      aliasResolver
    );
    const importedFile = importResolution.resolved_abs_file_path;
    resolvedByTsconfig = importResolution.resolved_by_tsconfig || null;
    resolverScope = importResolution.resolver_scope || resolverScope;

    if (importedFile) {
      targetAbsFilePath = importedFile;
      resolvedVia = "import";

      let requestedSymbol = callSite.symbol;
      if (importBinding.kind === "named" && importBinding.imported_symbol) {
        requestedSymbol = importBinding.imported_symbol;
      } else if (importBinding.kind === "default") {
        requestedSymbol = "default";
      } else if (importBinding.kind === "namespace" && importBinding.imported_symbol) {
        requestedSymbol = importBinding.imported_symbol;
      }

      const exportResolution = await resolveExportedSymbol(
        importedFile,
        requestedSymbol,
        astCache,
        resolutionCache,
        aliasResolver
      );

      if (exportResolution) {
        targetAbsFilePath = exportResolution.target_abs_file_path;
        targetSymbol = exportResolution.target_symbol;
        targetClassSymbol = exportResolution.target_class_symbol || null;
        targetDeclaration = exportResolution.target_declaration || null;
        resolvedVia = exportResolution.resolved_via || resolvedVia;
        resolvedByTsconfig = exportResolution.resolved_by_tsconfig || resolvedByTsconfig;
        resolverScope = exportResolution.resolver_scope || resolverScope;
      } else if (requestedSymbol === "default") {
        const importedFileInfo = await loadAstExpansionFileInfo(importedFile, astCache);
        targetSymbol = importedFileInfo.default_symbol || callSite.symbol;
      } else {
        targetSymbol = requestedSymbol;
      }
    } else {
      resolvedVia = "external_or_unresolved_import";
      targetAbsFilePath = null;
    }
  } else if (callSite.receiver_type_hint && callSite.receiver_type_hint.class_symbol) {
    targetClassSymbol = callSite.receiver_type_hint.class_symbol;
    resolvedVia = "receiver_type_hint";

    const classImportBinding =
      callSite.receiver_type_hint.class_import_binding ||
      currentFileInfo.imports.get(callSite.receiver_type_hint.class_symbol) ||
      null;

    if (classImportBinding) {
      resolvedModuleSpecifier = classImportBinding.module_specifier || null;
      const classImportResolution = await resolveLocalImportFile(
        currentFileInfo.abs_file_path,
        classImportBinding.module_specifier,
        resolutionCache,
        aliasResolver
      );
      const importedFile = classImportResolution.resolved_abs_file_path;
      if (!resolvedByTsconfig) {
        resolvedByTsconfig = classImportResolution.resolved_by_tsconfig || null;
      }
      resolverScope = classImportResolution.resolver_scope || resolverScope;

      if (importedFile) {
        const classRequestedSymbol =
          classImportBinding.kind === "default"
            ? "default"
            : classImportBinding.imported_symbol || targetClassSymbol;
        const classResolution = await resolveExportedSymbol(
          importedFile,
          classRequestedSymbol,
          astCache,
          resolutionCache,
          aliasResolver
        );

        if (classResolution) {
          targetAbsFilePath = classResolution.target_abs_file_path;
          targetClassSymbol = classResolution.target_symbol;
          resolvedVia = "receiver_type_hint_import";
          resolvedByTsconfig = classResolution.resolved_by_tsconfig || resolvedByTsconfig;
          resolverScope = classResolution.resolver_scope || resolverScope;
        } else {
          targetAbsFilePath = importedFile;
          resolvedVia = "receiver_type_hint_import_unresolved";
          if (classImportBinding.kind === "named" && classImportBinding.imported_symbol) {
            targetClassSymbol = classImportBinding.imported_symbol;
          } else if (classImportBinding.kind === "default") {
            const importedFileInfo = await loadAstExpansionFileInfo(importedFile, astCache);
            targetClassSymbol = importedFileInfo.default_symbol || targetClassSymbol;
          }
        }
      } else {
        resolvedVia = "external_or_unresolved_type_import";
        targetAbsFilePath = null;
      }
    }
  }

  if (!targetAbsFilePath) {
    return {
      target_symbol: targetSymbol,
      target_class_symbol: targetClassSymbol,
      target_abs_file_path: null,
      target_declaration: null,
      resolved_via: resolvedVia,
      resolved_module_specifier: resolvedModuleSpecifier,
      resolved_by_tsconfig: resolvedByTsconfig,
      resolver_scope: resolverScope,
    };
  }

  let targetFileInfo;
  try {
    targetFileInfo = await loadAstExpansionFileInfo(targetAbsFilePath, astCache);
  } catch {
    return {
      target_symbol: targetSymbol,
      target_class_symbol: targetClassSymbol,
      target_abs_file_path: targetAbsFilePath,
      target_declaration: null,
      resolved_via: "target_file_unreadable",
      resolved_module_specifier: resolvedModuleSpecifier,
      resolved_by_tsconfig: resolvedByTsconfig,
      resolver_scope: resolverScope,
    };
  }

  if (!targetDeclaration) {
    targetDeclaration = pickBestDeclaration(
      targetFileInfo.declarations,
      targetSymbol,
      callSite.line,
      targetClassSymbol
    );

    if (!targetDeclaration && targetClassSymbol) {
      targetDeclaration = pickBestDeclaration(targetFileInfo.declarations, targetSymbol, callSite.line, null);
    }
  }

  return {
    target_symbol: targetSymbol,
    target_class_symbol: targetDeclaration?.class_symbol || targetClassSymbol,
    target_abs_file_path: targetAbsFilePath,
    target_declaration: targetDeclaration,
    resolved_via: resolvedVia,
    resolved_module_specifier: resolvedModuleSpecifier,
    resolved_by_tsconfig: resolvedByTsconfig,
    resolver_scope: resolverScope,
  };
}
