import { describe, it } from "node:test";
import assert from "node:assert/strict";

let generateDefaultConfig, mergeConfig, validateConfig, getWorkspaceAdapters;

const before = async () => {
  const mod = await import("../dist/src/config.js");
  generateDefaultConfig = mod.generateDefaultConfig;
  mergeConfig = mod.mergeConfig;
  validateConfig = mod.validateConfig;
  getWorkspaceAdapters = mod.getWorkspaceAdapters;
};

describe("config", () => {
  it("generates default config from discovery result", async () => {
    await before();
    const result = {
      repoRoot: "/test",
      workspaces: [
        {
          name: "root",
          path: "/test",
          relativePath: ".",
          packageJson: { dependencies: { next: "15.0.0", "drizzle-orm": "0.45.0" } },
          stack: [
            { name: "Next.js", version: "15.0.0", adapter: "nextjs" },
            { name: "Drizzle ORM", version: "0.45.0", adapter: "drizzle" },
          ],
        },
        {
          name: "db",
          path: "/test/packages/db",
          relativePath: "packages/db",
          packageJson: { dependencies: { "drizzle-orm": "0.45.0" } },
          stack: [{ name: "Drizzle ORM", version: "0.45.0", adapter: "drizzle" }],
        },
      ],
      nodes: [],
      edges: [],
      gaps: [],
      stats: { filesScanned: 0, filesWithBoundaries: 0, filesNeedingReview: 0, nodesByKind: {}, edgesByType: {} },
    };

    const config = generateDefaultConfig(result);
    assert.equal(config.version, 1);
    assert.ok(config.stack.detected.includes("nextjs"));
    assert.ok(config.stack.detected.includes("drizzle"));
    assert.ok(config.workspaces["packages/db"]);
    assert.ok(config.exclude.length > 0);
    assert.equal(config.trace.maxDepth, 4);
  });

  it("merges config preserving agent edits", async () => {
    await before();
    const existing = {
      version: 1,
      stack: { detected: ["nextjs"], enabled: ["nextjs"], disabled: [] },
      workspaces: { "packages/db": { adapters: ["drizzle"] } },
      customBoundaries: [{ name: "queries", kind: "query", glob: "src/queries/*.ts", reason: "test" }],
      exclude: ["tests/**"],
      edgeRules: [],
      importAliases: { "@/": "src/" },
      trace: { maxDepth: 5, excludeTypeOnlyImports: true },
      _meta: { generatedAt: "2024-01-01", lastModifiedBy: "agent", projectName: "test" },
    };

    const fresh = {
      version: 1,
      stack: { detected: ["nextjs", "drizzle"], enabled: ["nextjs", "drizzle"], disabled: [] },
      workspaces: { "packages/db": { adapters: ["drizzle", "generic"] }, "packages/auth": { adapters: ["generic"] } },
      customBoundaries: [],
      exclude: ["**/*.test.ts"],
      edgeRules: [],
      importAliases: {},
      trace: { maxDepth: 4, excludeTypeOnlyImports: true },
      _meta: { generatedAt: "2024-01-02", lastModifiedBy: "kk_init", projectName: "test" },
    };

    const merged = mergeConfig(existing, fresh);

    // Agent edits preserved
    assert.equal(merged.customBoundaries.length, 1, "should preserve customBoundaries");
    assert.equal(merged.customBoundaries[0].name, "queries");
    assert.deepEqual(merged.importAliases, { "@/": "src/" });
    assert.equal(merged.trace.maxDepth, 5, "should preserve agent's trace depth");
    assert.deepEqual(merged.exclude, ["tests/**"], "should preserve agent's excludes");

    // Agent workspace override wins
    assert.deepEqual(merged.workspaces["packages/db"].adapters, ["drizzle"]);

    // New workspace from fresh detection added
    assert.ok(merged.workspaces["packages/auth"]);

    // Detected stack updated
    assert.ok(merged.stack.detected.includes("drizzle"));
  });

  it("validates config and catches issues", async () => {
    await before();
    const badConfig = {
      version: 2, // wrong version
      stack: { detected: [], enabled: [], disabled: [] },
      workspaces: {},
      customBoundaries: [
        { name: "", kind: "query", glob: "*.ts", reason: "test" }, // empty name
        { name: "test", kind: "", glob: "*.ts", reason: "test" }, // empty kind
      ],
      exclude: [],
      edgeRules: [{ when: {}, edgeType: "" }], // missing fields
      importAliases: {},
      trace: { maxDepth: 4, excludeTypeOnlyImports: true },
      _meta: { generatedAt: "", lastModifiedBy: "", projectName: "" },
    };

    const issues = validateConfig(badConfig);
    assert.ok(issues.length >= 3, `should find issues, found ${issues.length}`);
    assert.ok(issues.some((i) => i.field === "version"));
  });

  it("getWorkspaceAdapters respects overrides", async () => {
    await before();
    const config = {
      version: 1,
      stack: { detected: ["nextjs", "drizzle"], enabled: ["nextjs", "drizzle", "generic"], disabled: ["generic"] },
      workspaces: { "packages/db": { adapters: ["drizzle", "generic"] } },
      customBoundaries: [],
      exclude: [],
      edgeRules: [],
      importAliases: {},
      trace: { maxDepth: 4, excludeTypeOnlyImports: true },
      _meta: { generatedAt: "", lastModifiedBy: "", projectName: "" },
    };

    const dbAdapters = getWorkspaceAdapters(config, "packages/db");
    assert.ok(dbAdapters.includes("drizzle"));
    assert.ok(!dbAdapters.includes("generic"), "generic should be disabled");

    const rootAdapters = getWorkspaceAdapters(config, ".");
    assert.ok(rootAdapters.includes("nextjs"));
    assert.ok(rootAdapters.includes("drizzle"));
    assert.ok(!rootAdapters.includes("generic"), "generic should be disabled globally");
  });
});
