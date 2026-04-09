# Project Instructions

## Code Graph (KodeKlarity)

This project uses `kk` for code relationship mapping. The graph lives in `.kodeklarity/` and maps every route, server action, service, database table, and background job — plus how they connect.

### Always do this

**Before modifying any shared function, service, or API:**
```bash
kk rebuild                    # ensure graph is current
kk impact <function_name>     # see what breaks if you change this
```

**Before committing:**
```bash
kk search <term>              # find symbols when you don't know the exact name
kk risk                       # risk score 0-100 for your changes
```

**When investigating a bug or understanding code flow:**
```bash
kk upstream <symbol>          # what calls this?
kk downstream <symbol>        # what does this call?
kk why --from <A> --to <B>   # how are these connected?
kk side-effects <symbol>      # what DB/API/events does this trigger?
```

### When reviewing code (yours or PRs)

Before approving or submitting a change:
1. Run `kk impact` on each modified function to check blast radius
2. Run `kk side-effects` to verify no unexpected DB writes or API calls
3. Run `kk risk` for an overall risk score
4. If risk label is "high" or score > 70, explain to the user which downstream systems are affected

### When the graph seems incomplete

If `kk impact` returns fewer results than expected, the graph may be missing intermediate layers (query functions, services, repositories). Fix this:

1. Check project structure for data access / business logic layers
2. Edit `.kodeklarity/config.json` — add `customBoundaries` for the missing layer
3. Run `kk rebuild --force`
4. Verify with `kk impact` again

See `.kodeklarity/AGENT.md` for the full playbook.

### What NOT to do

- Don't skip `kk impact` for "small" changes — small changes to shared code have the biggest blast radius
- Don't ignore high risk scores — if `kk risk` says high, explain why before proceeding
- Don't manually edit `.kodeklarity/index/graph.sqlite` — use `kk rebuild` instead
