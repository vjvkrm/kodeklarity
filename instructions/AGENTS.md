# Project Instructions for Codex

## KodeKlarity (`kk`) — use it, improve it

Graph + memory layer. CLI or MCP (identical). Installed as devDependency (`kodeklarity`).

**When starting work or after pulling new code:**
- `kk rebuild` — update the graph to match current code
- `kk impact <symbol>` / `kk upstream <symbol>` / `kk side-effects <symbol>` — understand what you're about to touch (read the `memories` field!)
- If `kk impact` shows missing connections (e.g., server action calls a service but no service nodes appear), add a `customBoundary` rule in `.kodeklarity/config.json` matching the whole layer (not one symbol), then `kk rebuild --force`
- `kk risk` on your diff — if >70, explain affected systems before proceeding

**Before every commit (mandatory):**
- `kk precommit` — catches orphaned services, unwired code paths, missing table access, breaking changes, and missing tests. Fix all issues it reports before committing. If `orphans` are intentional (e.g., new service not wired yet), explain in the commit message.

**Memory discipline:**
- When you change a function's behavior, check `kk memory read --node <symbol>` — if there's a stale memory, update or remove it via `kk memory update <memory_id>`.
- When you make a non-obvious decision (why X, not Y), write a memory: `kk memory write "<content>" --node <symbol> --category decision`.
- Write only if all three hold: (1) non-obvious from code, (2) durable (true next month), (3) actionable (next agent behaves differently).
- Search first (`kk memory search "<keyword>"`); prefer `kk memory update` over duplicates.
- Categories: `gotcha`, `decision`, `warning`, `wiki` (rare). Worth writing: hidden DB constraints, load-bearing ordering, intentional-looking-like-bug. Not worth: "fixed X", restating code.
- Remove stale memories — if a memory references a deleted function or changed behavior, delete it. Code and memory must stay consistent.

**Full reference:** See [AGENT.md](https://github.com/vjvkrm/kodeklarity/blob/main/AGENT.md) for all commands, config options, graph model, memory system details, and first-run playbook.
