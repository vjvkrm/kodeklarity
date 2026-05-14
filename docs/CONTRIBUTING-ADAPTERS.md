# Adding a framework adapter

kk's framework adapters teach the graph about framework-specific patterns: Next.js pages and server actions, Drizzle tables, Trigger.dev tasks, etc. Each adapter is one file in `src/discover/adapters/` that implements a small interface.

Adapters are how kk gets richer than "TypeScript exports" — they emit boundary nodes (`route`, `api_route`, `server_action`, `table`, `background_job`, etc.) and framework-specific edges (e.g. `server_action --revalidates--> page`). Without an adapter, users have to describe these patterns themselves via `customBoundaries` in `.kodeklarity/config.json`.

## When an adapter is the right move

- **Framework has stable conventions.** Pages live in a known directory, exports follow a recognizable shape, etc.
- **Patterns aren't expressible as a single glob.** If `{ glob: "src/api/**/*.ts" }` covers it, a customBoundary is simpler — no adapter needed.
- **There's an audience.** kk is TypeScript-first; an adapter for a Rust framework doesn't fit. An adapter for a niche library is fine but expect it to land as `community`.

## The interface

From `src/discover/types.ts`:

```ts
export type AdapterMaturity = "stable" | "experimental" | "community";

export interface FrameworkAdapter {
  name: string;                        // unique adapter key, lowercase
  maturity?: AdapterMaturity;          // see "Maturity tiers" below
  detect(packageJson): DetectedStack | null;
  scan(workspace, repoRoot): Promise<AdapterResult>;
}
```

- **`detect`** returns `null` if the framework isn't present in the package.json. Otherwise returns `{ name, version, adapter: "<your-name>", maturity: "<your-tier>" }`. Run on every workspace's package.json (and root for monorepos).
- **`scan`** returns `{ adapter, nodes, edges }`. Called only if `detect` returned non-null.

## Maturity tiers

Declare on both the adapter export and the `DetectedStack` returned by `detect`:

| Tier | When to use it |
|---|---|
| `stable` | First-party maintained. Covers the common-case patterns. Has tests + a fixture. Currently: Next.js, Drizzle, Trigger.dev, generic. |
| `experimental` | First-party but limited coverage or in-progress. Currently: NestJS, Express, React. |
| `community` | Contributed and maintained by you, not the kk core team. New PRs default here. |

`kk init` surfaces the maturity in its output so users know what to expect.

## Writing the adapter

1. Create `src/discover/adapters/<your-framework>.ts`.
2. Pick a unique `name` (lowercase, no spaces — `"hono"`, `"trpc"`, `"prisma"`, etc.).
3. Set `maturity: "community"` initially.
4. Implement `detect()` — usually checks for the framework's main package in `dependencies` or `devDependencies` via `getDepVersion()` from `src/discover/adapters/utils.ts`.
5. Implement `scan()`:
   - Use `findFiles(wsRoot, [globs])` to find candidate files
   - Use `readFileSafe(file)` to read them
   - Use `makeNodeId(kind, relativePath, symbol)` to mint stable IDs — **the format is `kind:file:symbol` and IS the durable anchor for agent memory**, do not change it
   - Push `BoundaryNode`s with appropriate `kind` (see existing adapters for conventions: `route`, `api_route`, `server_action`, `service`, `table`, `background_job`, `component`, etc.)
   - Push `BoundaryEdge`s for framework-specific relationships (e.g., `server_action --revalidates--> page`)
6. Register the adapter in `src/discover/detector.ts` by importing it and adding to the `ADAPTERS` array.

## Use `parseFile()`, not regex

kk ships a small AST helper for adapters at `src/discover/ast-helpers.ts`. Use it. Regex-based detection produces false positives in comments and string literals, can't follow imports, and breaks on non-standard formatting. The helper costs ~1ms per file and eliminates all of that.

```ts
import { parseFile } from "../ast-helpers.js";

const parsed = parseFile(filePath, fileContent);
parsed.imports             // [{ source, specifiers, defaultImport, namespaceImport, line }, ...]
parsed.fileDirectives      // ["use server"] if at top of file
parsed.exports             // each with kind ("function" | "asyncFunction" | "constArrow" | ...)
parsed.decorators          // [{ name, args, appliedTo: { kind, name, line } }, ...]

parsed.hasImport("revalidatePath", "next/cache")    // bool — was it imported, from where
parsed.findCalls("revalidatePath")                  // [{ callee, line, args }, ...]
parsed.findCallsWithStringArg("revalidatePath")     // ↑ filtered to first-arg string literals
parsed.containingFunction(line)                     // name of enclosing function, if any
parsed.findDecoratorsByName("Controller")           // for NestJS-style decorators
```

### Before / after — Next.js server action detection

**Before** (regex — what the adapter used to do):

```ts
const hasUseServer = /['"]use server['"]/.test(content);
if (!hasUseServer) continue;

// Hand-roll a function extractor — misses inline 'use server',
// matches strings inside other code, etc.
const exportedFns = extractExportedFunctions(content);
for (const fn of exportedFns) {
  nodes.push({ kind: "server_action", symbol: fn.name, ... });
}
```

**After** (parseFile — what it does now):

```ts
const parsed = parseFile(filePath, content);
const fileLevelServer = parsed.fileDirectives.includes("use server");

for (const exp of parsed.exports) {
  const isFunctionLike =
    exp.kind === "function" ||
    exp.kind === "asyncFunction" ||
    exp.kind === "constArrow" ||
    exp.kind === "constAsyncArrow";
  if (!isFunctionLike) continue;

  // Either the whole file is 'use server', or this specific function's body is.
  if (!fileLevelServer && exp.bodyDirective !== "use server") continue;

  nodes.push({ kind: "server_action", symbol: exp.name, ... });
}
```

The second version is shorter, catches `export const foo = async () => { "use server"; ... }` (modern Next.js 15+ pattern), and produces no false positives from `"use server"` appearing inside a comment or string elsewhere in the file.

### Before / after — `revalidatePath` edges

**Before**:

```ts
const lines = content.split("\n");
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/revalidatePath\s*\(\s*['"]([^'"]+)['"]/);
  if (!m) continue;
  // ... then hand-roll findContainingFunction()
}
```

**After**:

```ts
const calls = parsed.findCallsWithStringArg("revalidatePath");
for (const call of calls) {
  const containingFn = parsed.containingFunction(call.line);
  // emit edge from containing server_action to the page with routePath === call.stringArg
}
```

### When regex is still fine

`findFiles(workspace, ["app/**/page.tsx"])` — filename glob matching. Don't AST-parse a file just to know it exists.

The `parseFile` cost only matters when you actually want to know what's *inside* the file.

## Testing

1. Add a fixture under `tests/fixtures/<your-framework>-app/` — a minimal package.json + a few files representative of the patterns your adapter handles.
2. Add tests under `tests/discover.test.js` (or a new file) that:
   - Run `discover()` on the fixture
   - Assert nodes/edges your adapter is supposed to emit
   - Assert that maturity is propagated through `DetectedStack`

Keep fixtures small. Don't ship a full Next.js app to test a route detector.

## Submitting

1. Run `npm run build && npm test` — must be green
2. Open a PR with:
   - The adapter file
   - The fixture
   - The tests
   - A short note in the PR description about what patterns are covered and what's deliberately out of scope

The kk core team will review for:
- Correctness of `detect()` (no false positives on similar-named packages)
- Quality of node `kind` values (use existing kinds if applicable; coordinate before inventing new ones)
- Stability of edge types
- Test coverage of the patterns you claim

## After landing

Community adapters are maintained by the contributor. If maintenance lapses and the adapter breaks against new framework versions, we'll either:
- Find a new maintainer (open issue, tag the framework community)
- Mark it `experimental` and add a warning to `kk init` output
- Remove it (with a deprecation period and migration notes)

Promotion to `experimental` or `stable` happens when the kk core team commits to maintenance — usually after the adapter has been in tree for 2+ releases without major issues.

## Anti-patterns

- **Don't replicate kk's customBoundary mechanism inside an adapter.** If your adapter just emits a `service` node for every export in a folder, that's a customBoundary, not an adapter. Adapters add value by knowing framework semantics — route paths, lifecycle, side effects.
- **Don't add LLM calls.** kk is deterministic static analysis. An adapter that needs an LLM doesn't fit.
- **Don't mutate global state.** Adapters run in parallel for monorepos. State your adapter holds across files must live inside the `scan()` call.
- **Don't emit nodes for every export.** Boundary nodes are *meaningful* boundaries (routes, services, tables). A generic export is just an export.

Questions: open an issue or draft a PR with `[RFC]` in the title.
