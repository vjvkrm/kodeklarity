// Unit tests for src/discover/ast-helpers.ts (parseFile).
//
// These cover the patterns adapter contributors actually need: imports,
// directives (file-level + body-level), exports of every shape, call sites,
// containing-function lookup, decorators.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function loadParseFile() {
  const mod = await import(path.join(REPO_ROOT, "dist", "src", "discover", "ast-helpers.js"));
  return mod.parseFile;
}

test("parseFile extracts named, default, and namespace imports with source + line", async () => {
  const parseFile = await loadParseFile();
  const src = `
import { revalidatePath, revalidateTag } from "next/cache";
import React from "react";
import * as ts from "typescript";
import "side-effect-module";

export const a = 1;
`;
  const p = parseFile("foo.ts", src);
  assert.equal(p.imports.length, 4);
  const cache = p.imports.find((i) => i.source === "next/cache");
  assert.ok(cache, "next/cache import missing");
  assert.deepEqual(cache.specifiers, ["revalidatePath", "revalidateTag"]);
  assert.equal(cache.line, 2);

  const react = p.imports.find((i) => i.source === "react");
  assert.equal(react.defaultImport, "React");

  const tsmod = p.imports.find((i) => i.source === "typescript");
  assert.equal(tsmod.namespaceImport, "ts");

  // hasImport convenience
  assert.equal(p.hasImport("revalidatePath", "next/cache"), true);
  assert.equal(p.hasImport("revalidatePath", "react"), false, "must scope by source");
  assert.equal(p.hasImport("React"), true, "default imports counted");
  assert.equal(p.hasImport("ts"), true, "namespace imports counted");
});

test("parseFile detects file-level 'use server' directive (leading)", async () => {
  const parseFile = await loadParseFile();
  const src = `"use server";\n\nexport async function action() { return 1; }`;
  const p = parseFile("a.ts", src);
  assert.deepEqual(p.fileDirectives, ["use server"]);
});

test("parseFile does NOT count a 'use server' string deep in the file as a file directive", async () => {
  const parseFile = await loadParseFile();
  const src = `
export const x = 1;
const y = "use server";  // this is just a string assignment, not a directive
`;
  const p = parseFile("a.ts", src);
  assert.deepEqual(p.fileDirectives, []);
});

test("parseFile detects inline 'use server' as function bodyDirective (Next.js 15+ pattern)", async () => {
  const parseFile = await loadParseFile();
  const src = `
export async function action() {
  "use server";
  return 1;
}

export async function other() {
  return 2;
}
`;
  const p = parseFile("a.ts", src);
  const action = p.exports.find((e) => e.name === "action");
  assert.equal(action.bodyDirective, "use server");
  const other = p.exports.find((e) => e.name === "other");
  assert.equal(other.bodyDirective, undefined);
});

test("parseFile exports cover function / async function / const arrow / const async arrow / class / type / interface", async () => {
  const parseFile = await loadParseFile();
  const src = `
export function a() {}
export async function b() {}
export const c = () => {};
export const d = async () => {};
export class E {}
export type F = string;
export interface G {}
`;
  const p = parseFile("a.ts", src);
  const byName = Object.fromEntries(p.exports.map((e) => [e.name, e.kind]));
  assert.equal(byName.a, "function");
  assert.equal(byName.b, "asyncFunction");
  assert.equal(byName.c, "constArrow");
  assert.equal(byName.d, "constAsyncArrow");
  assert.equal(byName.E, "class");
  assert.equal(byName.F, "type");
  assert.equal(byName.G, "interface");
});

test("parseFile captures initializerCall for `const x = pgTable('foo', {...})` patterns", async () => {
  const parseFile = await loadParseFile();
  const src = `
import { pgTable, integer, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: integer("id"),
  name: text("name"),
});
`;
  const p = parseFile("schema.ts", src);
  const users = p.exports.find((e) => e.name === "users");
  assert.ok(users, "users export missing");
  assert.ok(users.initializerCall, "no initializer call captured");
  assert.equal(users.initializerCall.callee, "pgTable");
  assert.equal(users.initializerCall.args[0].kind, "string");
  assert.equal(users.initializerCall.args[0].value, "users");
});

test("parseFile findCalls returns call sites for a callee name", async () => {
  const parseFile = await loadParseFile();
  const src = `
import { revalidatePath } from "next/cache";
export async function action() {
  await revalidatePath("/billing");
  await revalidatePath("/orders");
  const x = somethingElse();
}
`;
  const p = parseFile("a.ts", src);
  const calls = p.findCalls("revalidatePath");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].callee, "revalidatePath");
  assert.equal(calls[0].args[0].value, "/billing");
});

test("parseFile findCallsWithStringArg returns only string-arg calls and includes the literal", async () => {
  const parseFile = await loadParseFile();
  const src = `
revalidatePath("/foo");
const p = "/bar";
revalidatePath(p);  // identifier arg, should be filtered out
`;
  const p = parseFile("a.ts", src);
  const hits = p.findCallsWithStringArg("revalidatePath");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].stringArg, "/foo");
});

test("parseFile findCalls ignores commented and string-literal references", async () => {
  const parseFile = await loadParseFile();
  const src = `
// revalidatePath("/foo");
const helpText = "call revalidatePath() to invalidate";
function bar() {
  return "revalidatePath";
}
`;
  const p = parseFile("a.ts", src);
  // No real call expressions to revalidatePath anywhere.
  assert.equal(p.findCalls("revalidatePath").length, 0);
});

test("parseFile containingFunction walks the AST to find the enclosing function name", async () => {
  const parseFile = await loadParseFile();
  const src = `
export async function outer() {
  const x = 1;
  await revalidatePath("/foo");
  const y = 2;
}
`;
  const p = parseFile("a.ts", src);
  // revalidatePath is at line 4 (1-based with leading newline)
  assert.equal(p.containingFunction(4), "outer");
});

test("parseFile decorators captures class- and method-level decorators (NestJS shape)", async () => {
  const parseFile = await loadParseFile();
  const src = `
import { Controller, Get, Post } from "@nestjs/common";

@Controller("users")
export class UsersController {
  @Get(":id")
  findOne() {}

  @Post()
  create() {}
}
`;
  const p = parseFile("users.controller.ts", src);
  const controllerDec = p.findDecoratorsByName("Controller");
  assert.equal(controllerDec.length, 1);
  assert.equal(controllerDec[0].appliedTo.kind, "class");
  assert.equal(controllerDec[0].appliedTo.name, "UsersController");
  assert.equal(controllerDec[0].args[0].kind, "string");
  assert.equal(controllerDec[0].args[0].value, "users");

  const getDec = p.findDecoratorsByName("Get");
  assert.equal(getDec.length, 1);
  assert.equal(getDec[0].appliedTo.kind, "method");
  assert.equal(getDec[0].appliedTo.name, "findOne");
  // Method decorators must carry their parent class — adapters need this
  // to scope handlers to their controller (which @Get belongs to which @Controller).
  assert.equal(getDec[0].appliedTo.parentClass, "UsersController");
});

test("parseFile decorators handle multiple classes in one file without cross-scoping", async () => {
  const parseFile = await loadParseFile();
  const src = `
import { Controller, Get } from "@nestjs/common";

@Controller("a")
export class AController {
  @Get()
  one() {}
}

@Controller("b")
export class BController {
  @Get()
  two() {}
}
`;
  const p = parseFile("multi.ts", src);
  const gets = p.findDecoratorsByName("Get");
  assert.equal(gets.length, 2);
  const one = gets.find((d) => d.appliedTo.name === "one");
  const two = gets.find((d) => d.appliedTo.name === "two");
  assert.equal(one.appliedTo.parentClass, "AController");
  assert.equal(two.appliedTo.parentClass, "BController");
});

test("parseFile handles re-exports (named and *)", async () => {
  const parseFile = await loadParseFile();
  const src = `
export * from "./foo";
export { bar } from "./bar";
`;
  const p = parseFile("a.ts", src);
  const kinds = p.exports.map((e) => e.kind);
  assert.ok(kinds.includes("reExport"), "expected at least one re-export");
  // The named-reExport case should surface "bar" as the name.
  const named = p.exports.find((e) => e.name === "bar");
  assert.ok(named, "named re-export name not surfaced");
});

test("parseFile parses .tsx as JSX (handles angle brackets correctly)", async () => {
  const parseFile = await loadParseFile();
  // If we parsed this as plain .ts, the JSX syntax would fail.
  const src = `
import React from "react";
export const Hello = () => <div>hi</div>;
`;
  const p = parseFile("hello.tsx", src);
  const hello = p.exports.find((e) => e.name === "Hello");
  assert.ok(hello, "JSX file failed to parse export");
  assert.equal(hello.kind, "constArrow");
});

test("parseFile classifies `export default function foo()` as kind 'default'", async () => {
  const parseFile = await loadParseFile();
  const src = `export default function foo() { return 1; }`;
  const p = parseFile("a.ts", src);
  const foo = p.exports.find((e) => e.name === "foo");
  assert.ok(foo, "default-exported named function should appear in exports");
  assert.equal(foo.kind, "default", "must be kind 'default', not 'function'");
});

test("parseFile classifies `export default class Foo {}` as kind 'default'", async () => {
  const parseFile = await loadParseFile();
  const src = `export default class Foo {}`;
  const p = parseFile("a.ts", src);
  const foo = p.exports.find((e) => e.name === "Foo");
  assert.ok(foo, "default-exported named class should appear in exports");
  assert.equal(foo.kind, "default", "must be kind 'default', not 'class'");
});

test("parseFile classifies `export { foo }` (no from) as 'const', not 'reExport'", async () => {
  const parseFile = await loadParseFile();
  const src = `
function foo() {}
export { foo };
`;
  const p = parseFile("a.ts", src);
  const exp = p.exports.find((e) => e.name === "foo");
  assert.ok(exp, "named export of local binding should appear");
  assert.notEqual(exp.kind, "reExport", "local `export { foo }` is not a re-export");
});

test("parseFile still classifies `export { foo } from \"./x\"` as 'reExport'", async () => {
  const parseFile = await loadParseFile();
  const src = `export { foo } from "./x";`;
  const p = parseFile("a.ts", src);
  const exp = p.exports.find((e) => e.name === "foo");
  assert.ok(exp);
  assert.equal(exp.kind, "reExport");
});

test("parseFile object-literal args expose key→string-literal properties", async () => {
  const parseFile = await loadParseFile();
  const src = `task({ id: "send-email", retries: 3, foo: bar });`;
  const p = parseFile("a.ts", src);
  const calls = p.findCalls("task");
  assert.equal(calls.length, 1);
  const obj = calls[0].args[0];
  assert.equal(obj.kind, "object");
  assert.equal(obj.properties.id.kind, "string");
  assert.equal(obj.properties.id.value, "send-email");
  assert.equal(obj.properties.retries.kind, "number");
  assert.equal(obj.properties.retries.value, "3");
  assert.equal(obj.properties.foo.kind, "identifier");
  assert.equal(obj.properties.foo.value, "bar");
});
