# Project Instructions for Codex

## Code Graph (KodeKlarity)

This project has a code graph built by `kk`. It maps every route, server action, service, database table, and background job — plus how they connect. Use it to understand impact before making changes.

## Setup

Run once when starting work:
```bash
kk rebuild
```

## Workflow

### Before modifying code

```bash
# Check what breaks if you change this function
kk impact <function_name> --depth 3 --json

# Check what depends on this
kk upstream <symbol> --depth 2 --json

# Check what this calls
kk downstream <symbol> --depth 2 --json
```

### Before committing

```bash
# Get risk score for uncommitted changes
kk risk --json
```

### Understanding code flow

```bash
# What side effects does this trigger (DB writes, API calls, events)?
kk side-effects <symbol> --depth 4 --json

# How are two symbols connected?
kk why --from <symbolA> --to <symbolB> --depth 5 --json

# Graph overview
# Find symbols by name
kk search <term> --json

kk status --json
```

## Rules

1. Always run `kk impact` before modifying any shared function, service, or utility
2. Always run `kk risk` before creating a commit
3. If risk label is "high" or score > 70, include a note about affected downstream systems
4. Use `--json` flag for all kk commands to get structured output
5. If `kk impact` returns 0 results for a function that clearly has callers, the graph may need updating — edit `.kodeklarity/config.json` to add missing layers, then run `kk rebuild --force`

## Improving the graph

If the graph is missing connections, edit `.kodeklarity/config.json`:

```json
{
  "customBoundaries": [
    {
      "name": "query-layer",
      "kind": "query",
      "glob": "src/lib/queries/*.ts",
      "symbolPattern": "export (async )?function",
      "reason": "Data access layer"
    }
  ]
}
```

Then run `kk rebuild --force`.
