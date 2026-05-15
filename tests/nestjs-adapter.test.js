// End-to-end test for the NestJS adapter using an in-memory fixture.
// The repo has no NestJS test fixture (the adapter is "experimental") —
// this gives us regression coverage for the parseFile() migration without
// requiring fixture files on disk.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function loadAdapter() {
  const mod = await import(path.join(REPO_ROOT, "dist", "src", "discover", "adapters", "nestjs.js"));
  return mod.nestjsAdapter;
}

async function makeFixture(files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kk-nestjs-"));
  await fs.writeFile(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { "@nestjs/core": "10.0.0" } })
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return tmp;
}

test("nestjs adapter: @Controller + scoped @Get/@Post → controller + api_route nodes", async () => {
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/users.controller.ts": `
import { Controller, Get, Post } from "@nestjs/common";

@Controller("users")
export class UsersController {
  @Get(":id")
  findOne() {}

  @Post()
  create() {}
}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } },
      stack: [{ name: "NestJS", version: "10.0.0", adapter: "nestjs", maturity: "experimental" }],
    };
    const result = await adapter.scan(workspace, tmp);

    const controllers = result.nodes.filter((n) => n.kind === "controller");
    assert.equal(controllers.length, 1);
    assert.equal(controllers[0].symbol, "UsersController");
    assert.equal(controllers[0].metadata.routePrefix, "users");

    const routes = result.nodes.filter((n) => n.kind === "api_route");
    assert.equal(routes.length, 2, "should have 2 routes (GET + POST)");
    const get = routes.find((r) => r.metadata.httpMethod === "GET");
    const post = routes.find((r) => r.metadata.httpMethod === "POST");
    assert.equal(get.metadata.methodName, "findOne");
    assert.equal(get.symbol, "GET /users/:id");
    assert.equal(post.metadata.methodName, "create");
    assert.equal(post.symbol, "POST /users");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: multiple controllers in one file don't cross-scope methods", async () => {
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/multi.ts": `
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
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);

    const controllers = result.nodes.filter((n) => n.kind === "controller").map((n) => n.symbol).sort();
    assert.deepEqual(controllers, ["AController", "BController"]);

    // Crucially: each @Get is scoped to its parent controller via routePrefix.
    const routes = result.nodes.filter((n) => n.kind === "api_route");
    assert.equal(routes.length, 2);
    const inA = routes.find((r) => r.metadata.routePrefix === "a");
    const inB = routes.find((r) => r.metadata.routePrefix === "b");
    assert.equal(inA.metadata.methodName, "one");
    assert.equal(inB.metadata.methodName, "two");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: @Injectable → service node, not double-registered if already controller", async () => {
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/users.service.ts": `
import { Injectable } from "@nestjs/common";

@Injectable()
export class UsersService {
  findAll() { return []; }
}
`,
    // Same class name on a different file — should appear as service (not collide).
    "src/other.ts": `
import { Injectable } from "@nestjs/common";

@Injectable()
export class AuthService {}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);
    const services = result.nodes.filter((n) => n.kind === "service").map((n) => n.symbol).sort();
    assert.deepEqual(services, ["AuthService", "UsersService"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: @Injectable with options object still detected", async () => {
  // Regression: the old regex /\@Injectable\(\)/ exact match missed `@Injectable({ scope: Scope.REQUEST })`.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/scoped.service.ts": `
import { Injectable, Scope } from "@nestjs/common";

@Injectable({ scope: Scope.REQUEST })
export class ScopedService {}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);
    const services = result.nodes.filter((n) => n.kind === "service");
    assert.equal(services.length, 1, "Injectable with options object must be detected");
    assert.equal(services[0].symbol, "ScopedService");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: @Module → module node", async () => {
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/app.module.ts": `
import { Module } from "@nestjs/common";

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);
    const modules = result.nodes.filter((n) => n.kind === "module");
    assert.equal(modules.length, 1);
    assert.equal(modules[0].symbol, "AppModule");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: @Controller(\"users\") + @Get() yields 'GET /users' (no trailing slash)", async () => {
  // The migration commit message claims this trailing-slash quirk was fixed.
  // Pin it.
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/users.controller.ts": `
import { Controller, Get } from "@nestjs/common";

@Controller("users")
export class UsersController {
  @Get()
  findAll() {}
}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);
    const routes = result.nodes.filter((n) => n.kind === "api_route");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].symbol, "GET /users", "empty routePath must not produce trailing slash");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: @Controller() with no arg + @Get() with no arg yields 'GET /'", async () => {
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/root.controller.ts": `
import { Controller, Get } from "@nestjs/common";

@Controller()
export class RootController {
  @Get()
  root() {}
}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);
    const routes = result.nodes.filter((n) => n.kind === "api_route");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].symbol, "GET /", "empty prefix + empty path should be '/'");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("nestjs adapter: @UseGuards(A, B) → one guard node per identifier", async () => {
  const adapter = await loadAdapter();
  const tmp = await makeFixture({
    "src/guarded.controller.ts": `
import { Controller, Get, UseGuards } from "@nestjs/common";

@Controller("guarded")
export class GuardedController {
  @UseGuards(AuthGuard, RoleGuard)
  @Get()
  list() {}
}
`,
  });
  try {
    const workspace = {
      name: "fixture", path: tmp, relativePath: ".",
      packageJson: { dependencies: { "@nestjs/core": "10.0.0" } }, stack: [],
    };
    const result = await adapter.scan(workspace, tmp);
    const guards = result.nodes.filter((n) => n.kind === "guard").map((n) => n.symbol).sort();
    assert.deepEqual(guards, ["AuthGuard", "RoleGuard"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
