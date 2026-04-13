# KodeKlarity — drop-in instruction files

This folder contains ready-to-paste agent rules for every major coding tool. Copy the file that matches your tool into your project at the location shown below. Modify it freely for your project — loosen or tighten the memory-writing bar however your team prefers.

| Tool | Use this file | Where it goes |
|------|---------------|---------------|
| Claude Code | `CLAUDE.md` | Project root: `./CLAUDE.md` (or `~/.claude/CLAUDE.md` for global) |
| Codex | `AGENTS.md` | Project root: `./AGENTS.md` |
| Cursor | `cursorrules.md` | Project root: `./.cursorrules` (rename on copy) or `./.cursor/rules/kodeklarity.md` |
| Windsurf | `windsurfrules.md` | Project root: `./.windsurfrules` (rename on copy) |
| Any other MCP-compatible tool | any of the above as a starting point | your tool's rules file |

All four files have the same content — just the filename and headline differ so each tool's agent reads it correctly.

---

## Before you copy — install `kk`

```bash
npm install -g kodeklarity
kk init        # scans your project, builds the graph
```

## Optional — wire up the MCP server

Skip this if you want your agent to use `kk` via shell commands only. Add it if you want the MCP tools (`kk_impact`, `kk_memory_write`, …) callable directly.

### Claude Code

Add to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):

```json
{
  "mcpServers": {
    "kodeklarity": {
      "command": "kk-mcp"
    }
  }
}
```

### Cursor / Windsurf / other MCP-compatible tools

Add to your tool's MCP server config:

```json
{
  "kodeklarity": {
    "command": "kk-mcp"
  }
}
```

### Codex

Codex doesn't need MCP setup — it runs `kk` via shell. The `AGENTS.md` file already uses CLI commands.

---

## After setup

1. Confirm with `kk status` — should show node/edge counts
2. Your agent reads the rules file automatically
3. No additional prompting needed

## What the rules file tells your agent

The rules you're pasting teach your agent to:

- **USE** the graph before every code change (`kk_impact`, `kk_upstream`, reading surfaced `memories`)
- **BUILD** the graph — add `customBoundaries` to config when layers are missing (permanent improvement)
- **WRITE memory** selectively using the three-gate test (non-obvious + durable + actionable) to keep token cost low

Modify the three-gate test for your team's preferences. The default bar is intentionally high to keep memory focused on things that actually matter.
