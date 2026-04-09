import type { FrameworkAdapter, BoundaryNode, BoundaryEdge } from "../types.js";
import { findFiles, readFileSafe, findLineNumber, toRelative, makeNodeId, getDepVersion, shouldExclude } from "./utils.js";

export const drizzleAdapter: FrameworkAdapter = {
  name: "drizzle",

  detect(packageJson) {
    const version = getDepVersion(packageJson, "drizzle-orm");
    if (!version) return null;
    return { name: "Drizzle ORM", version, adapter: "drizzle" };
  },

  async scan(workspace, repoRoot) {
    const nodes: BoundaryNode[] = [];
    const edges: BoundaryEdge[] = [];
    const wsRoot = workspace.path;

    const tsFiles = await findFiles(wsRoot, ["**/*.ts", "**/*.tsx"]);
    const sourceFiles = tsFiles.filter((f) => !shouldExclude(f));

    for (const file of sourceFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = toRelative(file, repoRoot);

      // Find pgTable / sqliteTable / mysqlTable definitions
      const tableMatches = [
        ...content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(pgTable|sqliteTable|mysqlTable)\s*\(\s*['"](\w+)['"]/g),
      ];

      for (const match of tableMatches) {
        const varName = match[1];
        const tableType = match[2];
        const tableName = match[3];
        const line = findLineNumber(content, match[0]);

        nodes.push({
          id: makeNodeId("table", rel, tableName),
          kind: "table",
          symbol: tableName,
          file: rel,
          line,
          reason: `Drizzle ${tableType}: ${tableName}`,
          adapter: "drizzle",
          metadata: { varName, tableType, tableName, framework: "drizzle" },
        });

        // Check for .policy() chains (RLS)
        const policyRegex = new RegExp(`${varName}[\\s\\S]*?\\.policy\\s*\\(\\s*['"]([^'"]+)['"]`, "g");
        const policyMatches = [...content.matchAll(policyRegex)];
        for (const pm of policyMatches) {
          const policyName = pm[1];
          const policyLine = findLineNumber(content, pm[0]);
          nodes.push({
            id: makeNodeId("rls_policy", rel, `${tableName}.${policyName}`),
            kind: "rls_policy",
            symbol: `${tableName}.${policyName}`,
            file: rel,
            line: policyLine,
            reason: `RLS policy on ${tableName}: ${policyName}`,
            adapter: "drizzle",
            metadata: { tableName, policyName, framework: "drizzle" },
          });
        }
      }

      // Find db.select/insert/update/delete calls to link to tables
      const dbOps = [
        ...content.matchAll(/db\.(select|insert|update|delete)\s*\((?:\s*\w+\s*)?\)\s*\.(?:from|into|set)\s*\(\s*(\w+)\s*\)/g),
      ];

      // Find db.query.tableName.findMany/findFirst/findUnique calls (Drizzle query API)
      const dbQueryOps = [
        ...content.matchAll(/db\.query\.(\w+)\.(findMany|findFirst|findUnique)\s*\(/g),
      ];

      for (const qop of dbQueryOps) {
        const queryTableName = qop[1];
        const queryMethod = qop[2];
        const qopLine = findLineNumber(content, qop[0]);

        const containingFn = findContainingFunction(content, qopLine);
        if (!containingFn) continue;

        // Match table name — db.query uses the JS variable name (e.g. memberRoles),
        // which matches the varName from pgTable definition
        const tableNode = nodes.find(
          (n) => n.kind === "table" && (n.metadata?.varName === queryTableName || n.symbol === queryTableName)
        );
        if (!tableNode) continue;

        const callerNodeId = makeNodeId("function", rel, containingFn);
        edges.push({
          from: callerNodeId,
          to: tableNode.id,
          edgeType: "reads_table",
          file: rel,
          line: qopLine,
          reason: `${containingFn} queries ${tableNode.symbol} via db.query.${queryTableName}.${queryMethod}`,
          adapter: "drizzle",
          metadata: { operation: queryMethod, queryApi: true, framework: "drizzle" },
        });
      }

      for (const op of dbOps) {
        const operation = op[1];
        const tableVar = op[2];
        const opLine = findLineNumber(content, op[0]);

        // Find which function contains this db operation
        const containingFn = findContainingFunction(content, opLine);
        if (!containingFn) continue;

        // Find the table node by variable name
        const tableNode = nodes.find(
          (n) => n.kind === "table" && n.metadata?.varName === tableVar
        );
        if (!tableNode) continue;

        const callerNodeId = makeNodeId("function", rel, containingFn);
        const edgeType = operation === "select" ? "reads_table" : "writes_table";

        edges.push({
          from: callerNodeId,
          to: tableNode.id,
          edgeType,
          file: rel,
          line: opLine,
          reason: `${containingFn} ${operation}s from ${tableNode.symbol}`,
          adapter: "drizzle",
          metadata: { operation, framework: "drizzle" },
        });
      }

      // Also find relations() definitions
      const relationMatches = [
        ...content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*relations\s*\(\s*(\w+)/g),
      ];

      for (const rm of relationMatches) {
        const relationVar = rm[1];
        const sourceTable = rm[2];
        const line = findLineNumber(content, rm[0]);

        // Look for references to other tables in the relation body
        const relationBody = extractRelationBody(content, line);
        if (relationBody) {
          const refMatches = [...relationBody.matchAll(/one\s*\(\s*(\w+)|many\s*\(\s*(\w+)/g)];
          for (const ref of refMatches) {
            const targetTableVar = ref[1] || ref[2];
            const targetNode = nodes.find(
              (n) => n.kind === "table" && n.metadata?.varName === targetTableVar
            );
            const sourceNode = nodes.find(
              (n) => n.kind === "table" && n.metadata?.varName === sourceTable
            );

            if (targetNode && sourceNode) {
              edges.push({
                from: sourceNode.id,
                to: targetNode.id,
                edgeType: "relates_to",
                file: rel,
                line,
                reason: `${sourceNode.symbol} relates to ${targetNode.symbol}`,
                adapter: "drizzle",
                metadata: { relationType: ref[1] ? "one" : "many", framework: "drizzle" },
              });
            }
          }
        }
      }
    }

    return { adapter: "drizzle", nodes, edges };
  },
};

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

function extractRelationBody(content: string, startLine: number): string | null {
  const lines = content.split("\n");
  let depth = 0;
  let body = "";
  let started = false;

  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === "(") { depth++; started = true; }
      if (char === ")") { depth--; }
      if (started) body += char;
      if (started && depth === 0) return body;
    }
    body += "\n";
  }
  return null;
}
