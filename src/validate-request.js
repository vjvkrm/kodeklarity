import path from "node:path";

export const INTAKE_MODES = Object.freeze(["auto", "full", "seed"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeActual(value) {
  if (value === undefined) {
    return "undefined";
  }

  try {
    const asJson = JSON.stringify(value);
    if (typeof asJson === "string") {
      return asJson.length > 140 ? `${asJson.slice(0, 137)}...` : asJson;
    }
  } catch {
    // ignore and fall back below
  }

  return String(value);
}

function pushIssue(issues, issue) {
  issues.push(issue);
}

function requiredIssue(pathValue, expected, actual, fix) {
  return {
    path: pathValue,
    code: "required",
    expected,
    actual: describeActual(actual),
    fix,
  };
}

function typeMismatchIssue(pathValue, expected, actual, fix) {
  return {
    path: pathValue,
    code: "type_mismatch",
    expected,
    actual: describeActual(actual),
    fix,
  };
}

function invalidValueIssue(pathValue, expected, actual, fix) {
  return {
    path: pathValue,
    code: "invalid_value",
    expected,
    actual: describeActual(actual),
    fix,
  };
}

function emptyStringIssue(pathValue, actual, fix) {
  return {
    path: pathValue,
    code: "empty_string",
    expected: "non-empty string",
    actual: describeActual(actual),
    fix,
  };
}

function requireString(value, fieldPath, issues, options = {}) {
  const required = options.required !== false;
  const fix = options.fix ?? `Set ${fieldPath} to a non-empty string.`;

  if (value === undefined || value === null) {
    if (required) {
      pushIssue(issues, requiredIssue(fieldPath, "string", value, fix));
    }
    return undefined;
  }

  if (typeof value !== "string") {
    pushIssue(issues, typeMismatchIssue(fieldPath, "string", value, fix));
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    pushIssue(issues, emptyStringIssue(fieldPath, value, fix));
    return undefined;
  }

  return trimmed;
}

function requirePositiveLine(value, fieldPath, issues, options = {}) {
  const required = options.required !== false;
  const fix = options.fix ?? `Set ${fieldPath} to a positive integer line number.`;

  if (value === undefined || value === null) {
    if (required) {
      pushIssue(issues, requiredIssue(fieldPath, "positive integer", value, fix));
    }
    return undefined;
  }

  if (!Number.isInteger(value)) {
    pushIssue(issues, typeMismatchIssue(fieldPath, "positive integer", value, fix));
    return undefined;
  }

  if (value < 1) {
    pushIssue(issues, invalidValueIssue(fieldPath, "integer >= 1", value, fix));
    return undefined;
  }

  return value;
}

function requireObjectArray(input, fieldPath, issues, options = {}) {
  const required = options.required === true;
  const minItems = options.minItems ?? 0;
  const fix = options.fix ?? `Provide ${fieldPath} as a JSON array.`;

  if (input === undefined) {
    if (required) {
      pushIssue(issues, requiredIssue(fieldPath, minItems > 0 ? `array with at least ${minItems} item(s)` : "array", input, fix));
    }
    return [];
  }

  if (!Array.isArray(input)) {
    pushIssue(issues, typeMismatchIssue(fieldPath, "array", input, fix));
    return [];
  }

  if (input.length < minItems) {
    pushIssue(
      issues,
      invalidValueIssue(
        fieldPath,
        `array with at least ${minItems} item(s)`,
        input,
        `Add at least ${minItems} item(s) to ${fieldPath}.`
      )
    );
  }

  return input;
}

function normalizeEntrypoints(input, issues) {
  const items = requireObjectArray(input, "entrypoints", issues, {
    required: false,
    minItems: 0,
  });

  return items
    .map((item, index) => {
      const base = `entrypoints[${index}]`;
      if (!isObject(item)) {
        pushIssue(
          issues,
          typeMismatchIssue(base, "object", item, `Set ${base} to an object with id/kind/file/symbol/line/reason.`)
        );
        return null;
      }

      const id = requireString(item.id, `${base}.id`, issues, {
        fix: `Add a stable id like \"ui.login.submit\" to ${base}.id.`,
      });
      const kind = requireString(item.kind, `${base}.kind`, issues, {
        fix: `Set ${base}.kind (example: \"frontend_event\").`,
      });
      const file = requireString(item.file, `${base}.file`, issues, {
        fix: `Set ${base}.file to the source file path for evidence.`,
      });
      const symbol = requireString(item.symbol, `${base}.symbol`, issues, {
        fix: `Set ${base}.symbol to the function/method name.`,
      });
      const line = requirePositiveLine(item.line, `${base}.line`, issues, {
        fix: `Set ${base}.line to a positive integer line number.`,
      });
      const reason = requireString(item.reason, `${base}.reason`, issues, {
        fix: `Set ${base}.reason explaining why this belongs to the feature boundary.`,
      });

      if (!id || !kind || !file || !symbol || !line || !reason) {
        return null;
      }

      return {
        id,
        kind,
        symbol,
        evidence: {
          file,
          line,
          reason,
        },
      };
    })
    .filter(Boolean);
}

function normalizeEdges(input, name, issues) {
  const items = requireObjectArray(input, name, issues, {
    required: false,
    minItems: 0,
  });

  return items
    .map((item, index) => {
      const base = `${name}[${index}]`;
      if (!isObject(item)) {
        pushIssue(
          issues,
          typeMismatchIssue(base, "object", item, `Set ${base} to an object with from/to/file/line/reason fields.`)
        );
        return null;
      }

      const from = requireString(item.from, `${base}.from`, issues, {
        fix: `Set ${base}.from to the source node id.`,
      });
      const to = requireString(item.to, `${base}.to`, issues, {
        fix: `Set ${base}.to to the destination node id.`,
      });
      const file = requireString(item.file, `${base}.file`, issues, {
        fix: `Set ${base}.file to the source file path for evidence.`,
      });
      const line = requirePositiveLine(item.line, `${base}.line`, issues, {
        fix: `Set ${base}.line to a positive integer line number.`,
      });
      const reason = requireString(item.reason, `${base}.reason`, issues, {
        fix: `Set ${base}.reason describing why this edge exists.`,
      });
      const symbol = requireString(item.symbol, `${base}.symbol`, issues, {
        required: false,
        fix: `Set ${base}.symbol to the relevant method/function name if available.`,
      });

      if (!from || !to || !file || !line || !reason) {
        return null;
      }

      return {
        from,
        to,
        symbol,
        evidence: {
          file,
          line,
          reason,
        },
      };
    })
    .filter(Boolean);
}

function normalizeSideEffects(input, issues) {
  const items = requireObjectArray(input, "side_effects", issues, {
    required: false,
    minItems: 0,
  });

  return items
    .map((item, index) => {
      const base = `side_effects[${index}]`;
      if (!isObject(item)) {
        pushIssue(
          issues,
          typeMismatchIssue(base, "object", item, `Set ${base} to an object with kind/target/file/line/reason fields.`)
        );
        return null;
      }

      const kind = requireString(item.kind, `${base}.kind`, issues, {
        fix: `Set ${base}.kind (example: \"db_read\", \"db_write\", \"external_http\").`,
      });
      const target = requireString(item.target, `${base}.target`, issues, {
        fix: `Set ${base}.target to the touched system or resource.`,
      });
      const file = requireString(item.file, `${base}.file`, issues, {
        fix: `Set ${base}.file to the source file path for evidence.`,
      });
      const line = requirePositiveLine(item.line, `${base}.line`, issues, {
        fix: `Set ${base}.line to a positive integer line number.`,
      });
      const reason = requireString(item.reason, `${base}.reason`, issues, {
        fix: `Set ${base}.reason describing the side effect.`,
      });
      const symbol = requireString(item.symbol, `${base}.symbol`, issues, {
        required: false,
        fix: `Set ${base}.symbol to the relevant method/function name if available.`,
      });

      if (!kind || !target || !file || !line || !reason) {
        return null;
      }

      return {
        kind,
        target,
        symbol,
        evidence: {
          file,
          line,
          reason,
        },
      };
    })
    .filter(Boolean);
}

function normalizeOrigins(input, issues, options = {}) {
  const required = options.required === true;
  const minItems = required ? 1 : 0;

  const items = requireObjectArray(input, "origins", issues, {
    required,
    minItems,
    fix: "Provide origins as an array of feature origin objects.",
  });

  return items
    .map((item, index) => {
      const base = `origins[${index}]`;
      if (!isObject(item)) {
        pushIssue(
          issues,
          typeMismatchIssue(base, "object", item, `Set ${base} to an object with file/symbol/line/reason fields.`)
        );
        return null;
      }

      const id = requireString(item.id, `${base}.id`, issues, {
        required: false,
        fix: `Set ${base}.id to a stable identifier (optional).`,
      });
      const kind = requireString(item.kind, `${base}.kind`, issues, {
        required: false,
        fix: `Set ${base}.kind (optional, example: \"frontend_event\").`,
      });
      const file = requireString(item.file, `${base}.file`, issues, {
        fix: `Set ${base}.file to the origin source file path.`,
      });
      const symbol = requireString(item.symbol, `${base}.symbol`, issues, {
        fix: `Set ${base}.symbol to the origin function/method name.`,
      });
      const line = requirePositiveLine(item.line, `${base}.line`, issues, {
        fix: `Set ${base}.line to a positive integer line number.`,
      });
      const reason = requireString(item.reason, `${base}.reason`, issues, {
        fix: `Set ${base}.reason describing why this is a feature origin.`,
      });

      if (!file || !symbol || !line || !reason) {
        return null;
      }

      return {
        id: id ?? `origin.${index + 1}`,
        kind: kind ?? "feature_origin",
        symbol,
        evidence: {
          file,
          line,
          reason,
        },
      };
    })
    .filter(Boolean);
}

function resolveMode(input, requestedMode) {
  if (requestedMode === "full" || requestedMode === "seed") {
    return requestedMode;
  }

  if (isObject(input) && Array.isArray(input.origins)) {
    return "seed";
  }

  return "full";
}

function buildValidationError(mode, issues) {
  return {
    status: "error",
    error_code: "INVALID_PAYLOAD",
    message: `Payload validation failed for mode '${mode}'.`,
    issues,
    retry_hint: `Fix the listed fields and retry: kk-codeslice artifact create --mode ${mode} --request <payload.json>`,
  };
}

export function normalizeAndValidatePayload(input, cwd, requestedMode = "auto") {
  const issues = [];

  if (!isObject(input)) {
    return {
      ok: false,
      error: buildValidationError("full", [
        typeMismatchIssue("$", "JSON object", input, "Send a top-level JSON object payload."),
      ]),
    };
  }

  const mode = resolveMode(input, requestedMode);

  const featureName = requireString(input.feature_name, "feature_name", issues, {
    fix: "Set feature_name to the working feature (example: \"authentication\").",
  });

  const repositoryRootRaw = requireString(input.repository_root, "repository_root", issues, {
    required: false,
    fix: "Set repository_root to repo path (or omit to default to current working directory).",
  });

  const normalizedRepositoryRoot = path.resolve(cwd, repositoryRootRaw ?? cwd);
  const notes = requireString(input.notes, "notes", issues, {
    required: false,
    fix: "Set notes to additional scope context if needed.",
  });

  const entrypoints = normalizeEntrypoints(input.entrypoints, issues);
  const apiEdges = normalizeEdges(input.api_edges, "api_edges", issues);
  const serviceEdges = normalizeEdges(input.service_edges, "service_edges", issues);
  const sideEffects = normalizeSideEffects(input.side_effects, issues);

  let origins = [];

  if (mode === "seed") {
    origins = normalizeOrigins(input.origins, issues, { required: true });
  } else {
    origins = normalizeOrigins(input.origins, issues, { required: false });

    const hasAtLeastOneBoundary =
      entrypoints.length + apiEdges.length + serviceEdges.length + sideEffects.length > 0;

    if (!hasAtLeastOneBoundary) {
      pushIssue(
        issues,
        invalidValueIssue(
          "$",
          "at least one item across entrypoints/api_edges/service_edges/side_effects",
          {
            entrypoints: entrypoints.length,
            api_edges: apiEdges.length,
            service_edges: serviceEdges.length,
            side_effects: sideEffects.length,
          },
          "Add boundary items or use --mode seed with origins[]."
        )
      );
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      error: buildValidationError(mode, issues),
    };
  }

  return {
    ok: true,
    value: {
      schema_version: "1.1",
      source: "llm_payload",
      intake_mode: mode,
      feature: {
        name: featureName,
      },
      repository: {
        root: normalizedRepositoryRoot,
        language: "typescript",
      },
      boundaries: {
        origins,
        entrypoints,
        api_edges: apiEdges,
        service_edges: serviceEdges,
        side_effects: sideEffects,
      },
      notes,
    },
  };
}
