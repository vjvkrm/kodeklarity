# Setup Instructions

Copy the file for your AI tool into your project. Each file goes to a specific location:

| Tool | File to copy | Where to put it |
|------|-------------|-----------------|
| Claude Code | `CLAUDE.md` | Project root: `./CLAUDE.md` |
| Codex | `AGENTS.md` | Project root: `./AGENTS.md` |
| Cursor | `.cursorrules` | Project root: `./.cursorrules` |
| Windsurf | `.windsurfrules` | Project root: `./.windsurfrules` |

## MCP Server Setup (required for all tools)

### Claude Code
Add to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):
```json
{
  "mcpServers": {
    "kodeklarity": {
      "command": "node",
      "args": ["/path/to/kodeklarity/dist/bin/kk-mcp.js"]
    }
  }
}
```

### Cursor
Add to Cursor Settings > MCP Servers:
```json
{
  "kodeklarity": {
    "command": "node",
    "args": ["/path/to/kodeklarity/dist/bin/kk-mcp.js"]
  }
}
```

### Windsurf
Add to Windsurf MCP config:
```json
{
  "kodeklarity": {
    "command": "node",
    "args": ["/path/to/kodeklarity/dist/bin/kk-mcp.js"]
  }
}
```

### Codex
Codex uses CLI tools directly. No MCP setup needed — it runs `kk` commands via shell.

## After Setup

1. Run `kk init` in your project root
2. The AI tool will automatically follow the instructions from the copied file
3. No additional prompting needed
