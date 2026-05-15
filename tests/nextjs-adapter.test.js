// End-to-end tests for the post-migration Next.js adapter.
// The existing tests/fixtures/nextjs-drizzle-app fixture covers file-level
// 'use server' detection. This file covers the patterns the parseFile() migration
// specifically *gained*: inline 'use server' (Next.js 15+) and const-arrow
// server actions. Also asserts that comment / string-literal matches don't
// produce false positives.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function loadAdapter() {
  const mod = await import(path.join(REPO_ROOT, "dist", "src", "discover", "adapters", "nextjs.js"));
  return mod.nextjsAdapter;
}

async function makeFixture(files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kk-next-"));
  await fs.writeFile(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { next: "15.0.0" } })
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return tmp;
}

function makeWorkspace(tmp) {
  return {
    name: "fixture",
    path: tmp,
    relativePath: ".",
    packageJson: { dependencies: { next: "15.0.0" } },
    stack: [{ name: "Next.js", version: "15.0.0", adapter: "nextjs", maturity: "stable" }],
  };
}

test("nextjs adapter: inline 'use server' inside a function body → server_action node", async () => {
  // The headline Next.js 15+ pattern the parseFile migration gained over the
  // regex version. The directive lives INSIDE the function body, not at the
  // file top — the old regex /['"]use server['"]/.test(content) would have
  // matched but couldn't scope which function it applied to.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/lib/actions.ts": `
export async function action() {
  "use server";
  return 1;
}

export async function notAnAction() {
  // No directive here; just a regular function.
  return 2;
}
`,
  });
  try {
    const result = await adapter.scan(makeWorkspace(tmp), tmp);
    const serverActions = result.nodes.filter((n) => n.kind === "server_action");
    assert.equal(serverActions.length, 1, "exactly one server action expected");
    assert.equal(serverActions[0].symbol, "action");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nextjs adapter: const arrow with inline 'use server' is detected", async () => {
  // export const x = async () => { "use server"; ... } — also missed by the
  // old regex which expected `export function` or file-level "use server".
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/lib/actions.ts": `
export const submit = async (data) => {
  "use server";
  return data;
};

export const helper = (x) => x + 1;  // not an action
`,
  });
  try {
    const result = await adapter.scan(makeWorkspace(tmp), tmp);
    const serverActions = result.nodes.filter((n) => n.kind === "server_action");
    assert.equal(serverActions.length, 1);
    assert.equal(serverActions[0].symbol, "submit");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nextjs adapter: file-level 'use server' still detected (regression guard)", async () => {
  // Make sure the migration didn't break the file-level pattern that the old
  // adapter handled correctly.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/lib/actions.ts": `"use server";

export async function login() { return 1; }
export async function logout() { return 2; }
`,
  });
  try {
    const result = await adapter.scan(makeWorkspace(tmp), tmp);
    const names = result.nodes
      .filter((n) => n.kind === "server_action")
      .map((n) => n.symbol)
      .sort();
    assert.deepEqual(names, ["login", "logout"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nextjs adapter: 'use server' inside a comment or string is NOT a false positive", async () => {
  // The old regex /['"]use server['"]/.test(content) would have matched in
  // both comments and string literals. parseFile() distinguishes them via AST.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/lib/notes.ts": `
// "use server" — talking about it here
const docs = "the use server directive";
export function describe() {
  return "use server is a Next.js feature";
}
`,
  });
  try {
    const result = await adapter.scan(makeWorkspace(tmp), tmp);
    const serverActions = result.nodes.filter((n) => n.kind === "server_action");
    assert.equal(serverActions.length, 0, "no server actions should be detected");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nextjs adapter: revalidatePath edge emitted when server action revalidates a page", async () => {
  // Regression guard — make sure the edge generation still works after the
  // findCallsWithStringArg + containingFunction migration.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "app/dashboard/page.tsx": `export default function Page() { return null; }`,
    "src/lib/actions.ts": `
"use server";
import { revalidatePath } from "next/cache";

export async function refresh() {
  await revalidatePath("/dashboard");
}
`,
  });
  try {
    const result = await adapter.scan(makeWorkspace(tmp), tmp);
    const revalidates = result.edges.filter((e) => e.edgeType === "revalidates");
    assert.equal(revalidates.length, 1, "one revalidates edge expected");
    // The edge should target the dashboard page node and come from the action.
    const action = result.nodes.find((n) => n.kind === "server_action" && n.symbol === "refresh");
    const page = result.nodes.find((n) => n.kind === "route");
    assert.ok(action, "refresh server_action node missing");
    assert.ok(page, "dashboard page route node missing");
    assert.equal(revalidates[0].from, action.id);
    assert.equal(revalidates[0].to, page.id);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nextjs adapter: revalidatePath in a COMMENT does NOT emit an edge (regression)", async () => {
  // The old regex would match commented `revalidatePath("/dashboard")` calls;
  // parseFile() correctly ignores them. Pin the behavior.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "app/dashboard/page.tsx": `export default function Page() { return null; }`,
    "src/lib/actions.ts": `
"use server";
import { revalidatePath } from "next/cache";

export async function refresh() {
  // await revalidatePath("/dashboard");
  return "noop";
}
`,
  });
  try {
    const result = await adapter.scan(makeWorkspace(tmp), tmp);
    const revalidates = result.edges.filter((e) => e.edgeType === "revalidates");
    assert.equal(revalidates.length, 0, "commented revalidatePath must not emit an edge");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
