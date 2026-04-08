import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readPayloadInput(requestArg, cwd) {
  const input = requestArg.trim();
  const raw = input === "-" ? await readStdin() : await fs.readFile(path.resolve(cwd, input), "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON payload: ${details}`);
  }
}

export function buildTemplatePayload(featureName, mode = "full") {
  const name = featureName && featureName.trim() ? featureName.trim() : "authentication";

  if (mode === "seed") {
    return {
      feature_name: name,
      repository_root: "./examples/sample-app",
      notes: "Seed mode: provide only origin points; graph expansion happens later.",
      origins: [
        {
          id: "origin.ui.login.submit",
          kind: "frontend_event",
          file: "src/features/auth/LoginForm.ts",
          symbol: "onSubmit",
          line: 8,
          reason: "Primary user entry into authentication flow",
        },
      ],
    };
  }

  return {
    feature_name: name,
    repository_root: "./examples/sample-app",
    notes: "Optional context from agent about scope assumptions.",
    entrypoints: [
      {
        id: "ui.login.submit",
        kind: "frontend_event",
        file: "src/features/auth/LoginForm.ts",
        symbol: "onSubmit",
        line: 8,
        reason: "User submits credentials from login form",
      },
    ],
    api_edges: [
      {
        from: "ui.login.submit",
        to: "api.post./auth/login",
        file: "src/features/auth/api.ts",
        symbol: "login",
        line: 7,
        reason: "Calls backend login endpoint",
      },
    ],
    service_edges: [
      {
        from: "api.post./auth/login",
        to: "service.auth.authenticate",
        file: "src/server/auth/auth.controller.ts",
        symbol: "loginController",
        line: 7,
        reason: "Controller delegates to auth service",
      },
    ],
    side_effects: [
      {
        kind: "db_read",
        target: "users",
        file: "src/server/auth/auth.service.ts",
        symbol: "authenticate",
        line: 10,
        reason: "Looks up user by email before password validation",
      },
    ],
  };
}

export async function writeNormalizedRequest(normalizedRequest, options) {
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const featureSlug = slugify(normalizedRequest.feature.name) || "feature";
  const uniqueToken = randomUUID().slice(0, 8);
  const requestId = `${featureSlug}-${Date.now()}-${uniqueToken}`;

  const outputRoot = options.outDir
    ? path.resolve(options.cwd, options.outDir)
    : path.resolve(options.cwd, ".kodeklarity", "requests", featureSlug);

  await fs.mkdir(outputRoot, { recursive: true });

  const outputPath = path.join(outputRoot, `${timestamp}-${uniqueToken}.json`);

  const outputPayload = {
    request_id: requestId,
    created_at: createdAt,
    ...normalizedRequest,
  };

  await fs.writeFile(outputPath, `${JSON.stringify(outputPayload, null, 2)}\n`, "utf8");

  const boundaries = normalizedRequest.boundaries || {};

  return {
    requestId,
    outputPath,
    counts: {
      origins: Array.isArray(boundaries.origins) ? boundaries.origins.length : 0,
      entrypoints: Array.isArray(boundaries.entrypoints) ? boundaries.entrypoints.length : 0,
      api_edges: Array.isArray(boundaries.api_edges) ? boundaries.api_edges.length : 0,
      service_edges: Array.isArray(boundaries.service_edges) ? boundaries.service_edges.length : 0,
      side_effects: Array.isArray(boundaries.side_effects) ? boundaries.side_effects.length : 0,
    },
  };
}
