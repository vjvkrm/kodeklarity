import type { DetectedStack, Workspace, FrameworkAdapter } from "./types.js";
import { nextjsAdapter } from "./adapters/nextjs.js";
import { drizzleAdapter } from "./adapters/drizzle.js";
import { nestjsAdapter } from "./adapters/nestjs.js";
import { expressAdapter } from "./adapters/express.js";
import { reactAdapter } from "./adapters/react.js";
import { triggerdevAdapter } from "./adapters/triggerdev.js";
import { genericAdapter } from "./adapters/generic.js";

/** All registered framework adapters, in detection priority order */
const ADAPTERS: FrameworkAdapter[] = [
  nextjsAdapter,
  nestjsAdapter,
  expressAdapter,
  reactAdapter,
  drizzleAdapter,
  triggerdevAdapter,
  genericAdapter,
];

function getDeps(packageJson: Record<string, unknown>): Record<string, string> {
  const deps = (packageJson.dependencies ?? {}) as Record<string, string>;
  const devDeps = (packageJson.devDependencies ?? {}) as Record<string, string>;
  return { ...deps, ...devDeps };
}

/**
 * Detect which frameworks/libraries are used in a workspace.
 * Also checks rootPackageJson for monorepo inheritance (deps hoisted to root).
 */
export function detectStack(workspace: Workspace, rootPackageJson?: Record<string, unknown>): DetectedStack[] {
  const detected: DetectedStack[] = [];

  for (const adapter of ADAPTERS) {
    // Try workspace's own package.json first
    let result = adapter.detect(workspace.packageJson);
    // If not found and we have root package.json, try that (monorepo dep hoisting)
    if (!result && rootPackageJson) {
      result = adapter.detect(rootPackageJson);
    }
    if (result) {
      detected.push(result);
    }
  }

  return detected;
}

/** Get the adapter instance by name */
export function getAdapter(adapterName: string): FrameworkAdapter | null {
  return ADAPTERS.find((a) => a.name === adapterName) ?? null;
}

/** Get all registered adapters */
export function getAllAdapters(): FrameworkAdapter[] {
  return ADAPTERS;
}
