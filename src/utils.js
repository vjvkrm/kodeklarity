import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizePathForCompare(inputPath) {
  return inputPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function toNullable(value) {
  return value === undefined ? null : value;
}

export function parseJsonObjectSafe(rawValue) {
  if (typeof rawValue !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON at ${filePath}: ${details}`);
  }
}

export async function readJsonFileLoose(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = ts.parseConfigFileTextToJson(filePath, raw);
  if (parsed.error) {
    const details = ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n");
    throw new Error(`invalid JSON at ${filePath}: ${details}`);
  }

  if (!isObject(parsed.config)) {
    throw new Error(`invalid JSON at ${filePath}: expected object`);
  }

  return parsed.config;
}

export function toRepoRelativePath(absFilePath, repositoryRoot) {
  if (typeof absFilePath !== "string" || !absFilePath.trim()) {
    return null;
  }

  const normalizedAbsPath = path.normalize(absFilePath);
  const relativePath = path.relative(repositoryRoot, normalizedAbsPath);
  const isInsideRepo =
    relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

  if (isInsideRepo) {
    return sanitizePathForCompare(relativePath);
  }

  return sanitizePathForCompare(normalizedAbsPath);
}

export function createGraphError(errorCode, message, details = {}) {
  const error = new Error(message);
  error.name = "GraphError";
  error.code = errorCode;
  error.details = isObject(details) ? details : {};
  return error;
}
