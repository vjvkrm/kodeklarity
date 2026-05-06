# Project Instructions for Codex

## KodeKlarity (`kk`) — use it, improve it

Graph + memory layer. CLI or MCP (identical). Installed as devDependency (`kodeklarity`).

**When starting work or after pulling new code:**
- `kk_rebuild` — update the graph to match current code
- `kk_impact <symbol>` / `kk_upstream <symbol>` / `kk_side_effects <symbol>` — understand what you're about to touch (read the `memories` field!)
- If `kk_impact` shows missing connections (e.g., server action calls a service but no service nodes appear), add a `customBoundary` rule in `.kodeklarity/config.json` matching the whole layer (not one symbol), then `kk_rebuild --force`

**Before every commit (mandatory):**
- `kk_precommit` — analyzes UNCOMMITTED changes only (working tree). Catches orphaned services, unwired code paths, missing table access, breaking changes, and missing tests. Fix all issues it reports before committing. If `orphans` are intentional (e.g., new service not wired yet), explain in the commit message.

**Branch / PR review:**
- `kk_review --base main` — analyzes ALL changes since the branch diverged from `main` (committed commits + uncommitted edits). Same output shape as `kk_precommit`, plus a `diff_window` field describing the merge-base and commit count. Use this for self-review of a feature branch or to review someone else's PR.

**Coverage gaps (both precommit and review):**
- If the response includes a `coverage_action` field, decide each listed file: add a `customBoundary` to `.kodeklarity/config.json` (it's a real boundary that should be tracked), or add the path to `ignoreCoverage` (it's an intentional non-boundary — entry point, type-only file, CLI dispatch, etc.). Then `kk_init --force` and re-run until clean. Don't claim done with uncovered files.

**Treat structural fields as risk signals (no separate score):**
- `breaking_changes[].verdict === "signature_changed"` or `"removed_or_renamed"` → review carefully; callers may break
- `breaking_changes[].verdict === "body_changed"` → verify behavior is preserved
- `tables_touched.writes` non-empty → confirm migration / RLS / audit
- `orphans` non-empty → unwired code, confirm intentional or fix
- `coverage_action` present → fix config before claiming done

**Visual exploration (optional):**
- `kk dashboard` — opens a local web UI for clicking through the precommit/impact graph with diff inspection. Useful when querying by symbol is slower than seeing the layout.

**Memory discipline:**
- When you change a function's behavior, check `kk_memory_read <symbol>` — if there's a stale memory, update or remove it via `kk_memory_update`.
- When you make a non-obvious decision (why X, not Y), write a memory: `kk_memory_write` with category `decision` or `gotcha`.
- Write only if all three hold: (1) non-obvious from code, (2) durable (true next month), (3) actionable (next agent behaves differently).
- Search first (`kk_memory_search`); prefer `kk_memory_update` over duplicates.
- Categories: `gotcha`, `decision`, `warning`, `wiki` (rare). Worth writing: hidden DB constraints, load-bearing ordering, intentional-looking-like-bug. Not worth: "fixed X", restating code.
- Remove stale memories — if a memory references a deleted function or changed behavior, delete it. Code and memory must stay consistent.

**Full reference:** See [AGENT.md](https://github.com/vjvkrm/kodeklarity/blob/main/AGENT.md) for all commands, config options, graph model, memory system details, and first-run playbook.
