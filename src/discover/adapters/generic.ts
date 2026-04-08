import type { FrameworkAdapter, BoundaryNode, BoundaryEdge, DiscoveryGap } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, shouldExclude } from "./utils.js";

/** Generic adapter — catches patterns that aren't framework-specific */
export const genericAdapter: FrameworkAdapter = {
  name: "generic",

  detect(_packageJson) {
    // Always active — catches generic patterns
    return { name: "Generic", version: null, adapter: "generic" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const gaps: DiscoveryGap[] = [];
    const wsRoot = workspace.path;

    const tsFiles = await findFiles(wsRoot, ["**/*.ts", "**/*.tsx"]);
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = toRelative(file, repoRoot);

      // Find fetch() calls to external APIs
      const fetchMatches = [
        ...content.matchAll(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g),
      ];

      for (const fm of fetchMatches) {
        const url = fm[1];
        const line = findLineNumber(content, fm[0]);

        // Only flag external URLs, not relative API calls
        if (url.startsWith("http://") || url.startsWith("https://")) {
          const domain = extractDomain(url);
          const containingFn = findContainingFunction(content, line);

          nodes.push({
            id: makeNodeId("external_api", rel, domain),
            kind: "external_api",
            symbol: domain,
            file: rel,
            line,
            reason: `External API call: ${url}`,
            adapter: "generic",
            metadata: { url, domain },
          });

          if (containingFn) {
            edges.push({
              from: makeNodeId("function", rel, containingFn),
              to: makeNodeId("external_api", rel, domain),
              edgeType: "external_call",
              file: rel,
              line,
              reason: `${containingFn} calls external API: ${domain}`,
              adapter: "generic",
            });
          }
        }
      }

      // Find event emitter patterns
      const emitMatches = [
        ...content.matchAll(/\.emit\s*\(\s*['"]([^'"]+)['"]/g),
        ...content.matchAll(/\.publish\s*\(\s*['"]([^'"]+)['"]/g),
        ...content.matchAll(/\.dispatch\s*\(\s*['"]([^'"]+)['"]/g),
      ];

      for (const em of emitMatches) {
        const eventName = em[1];
        const line = findLineNumber(content, em[0]);

        nodes.push({
          id: makeNodeId("event", rel, eventName),
          kind: "event",
          symbol: eventName,
          file: rel,
          line,
          reason: `Event emission: ${eventName}`,
          adapter: "generic",
          metadata: { eventName },
        });
      }

      // Flag dynamic dispatch patterns as gaps for agent review
      const dynamicPatterns = [
        { pattern: /\w+\[(\w+)\]\s*\(/, reason: "dynamic_dispatch" },
        { pattern: /eval\s*\(/, reason: "eval_usage" },
        { pattern: /new\s+Function\s*\(/, reason: "dynamic_function" },
      ];

      for (const dp of dynamicPatterns) {
        const match = content.match(dp.pattern);
        if (match) {
          const line = findLineNumber(content, match[0]);
          // This is returned as a gap but stored in the adapter result
          // The orchestrator collects gaps from adapter results
          (gaps as DiscoveryGap[]).push({
            file: rel,
            lines: `${line}`,
            reason: dp.reason,
            hint: `Contains ${dp.reason.replace(/_/g, " ")} pattern — agent should review to resolve targets`,
          });
        }
      }
    }

    return {
      adapter: "generic",
      nodes,
      edges,
      gaps,
    };
  },
};

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.split("/")[2] || url;
  }
}

function findContainingFunction(content: string, targetLine: number): string | null {
  const lines = content.split("\n");
  for (let i = targetLine - 1; i >= 0; i--) {
    const match = lines[i].match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (match) return match[1];
    const constMatch = lines[i].match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (constMatch) return constMatch[1];
  }
  return null;
}
