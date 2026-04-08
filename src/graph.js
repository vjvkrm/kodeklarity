// Barrel re-export file — preserves original graph.js public API.
// Each function lives in its focused module; this file wires them
// back so existing consumers (cli.js) keep working unchanged.

export { resolveDbPath, initGraphDb } from "./db.js";
export {
  verifyGraphRequestFile,
  buildGraphFromRequestFile,
  exportGraphSnapshot,
  profileGraphWorkflow,
} from "./build.js";
export {
  queryImpact,
  queryDownstream,
  queryUpstream,
  querySideEffects,
  queryRisk,
  queryWhy,
  queryBuildDiff,
  rebuildGraphFromDiff,
} from "./query.js";
