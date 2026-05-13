# Evals & Benchmarks

**Strategy: strictly public benchmarks.**

We don't define our own tests. The public coding benchmarks already measure the property kk is designed for — sustained context across long-horizon coding tasks. If kk's design (graph + memory pinned to nodes) is right, it lifts the public numbers. If it doesn't, the design needs fixing and we want to know.

This document lists the benchmarks we'll run, the experimental design, and the open questions.

---

## The benchmarks (public only)

| Benchmark | TS coverage | What it tests | Best for measuring |
|---|---|---|---|
| **SWE-Bench Pro** | ✓ TS+JS subset (Scale AI) | Long-horizon issue resolution, 1,865 tasks across 41 repos, multi-file patches | Graph + within-repo memory carryover |
| **CrossCodeEval** | ✓ TS native (NeurIPS 2023) | Cross-file code completion — *requires* cross-file context | Pure graph traversal |
| **Multi-SWE-bench** | ✓ TS+JS (NeurIPS 2025) | Multilingual issue resolution, 1,632 instances | Peer-reviewed cross-check of SWE-Bench Pro |
| **SWE-EVO** | TBD — verify TS | Long-horizon software *evolution*, multi-step changes | Memory across changes — closest public benchmark to our story |
| **LoCoBench** | TBD — verify TS | Long-context software engineering, 10K–1M tokens, 8 task categories | Whether kk-fed context outperforms raw long-context |

**Explicitly excluded** (different product):

| Excluded | Why |
|---|---|
| LongMemEval, LoCoMo, MemoryAgentBench | Chat-focused. No codebase, no graph to use. Running these forces kk to play a graph-less game. |
| SWE-Bench Verified | Python only. Also contaminated — 80.9% on Verified vs 45.9% on Pro for the same model. |
| RepoBench | Python + Java only, no TS coverage. |
| ProjDevBench | No initial codebase — kk has nothing to graph. |
| TheAgentCompany | Broader workflow scope; coding is one task type among many. |

---

## Experimental design — three configs

For each benchmark we run, three configs (not two). The C0→C1→C2 ladder isolates what graph contributes vs what memory contributes on top.

| Config | What kk provides | What this isolates |
|---|---|---|
| **C0 — Baseline** | Nothing. Claude Code on its own. | The vanilla agent number. Matches the public leaderboard. |
| **C1 — Graph only** | `kk impact / upstream / downstream / side-effects / precommit / review`. Memory tools disabled. | **Graph traversal's marginal contribution.** Does structural code intelligence lift the agent? |
| **C2 — Graph + Memory** | C1 + `kk memory write/read/search`. Memories persist across tasks within the same repo. | **Memory's marginal contribution on top of graph.** Does code-anchored memory compound across tasks? |

**Where memory's value actually shows up:**

Memory has nothing to do on single-turn or independent-task benchmarks. So C1 = C2 on:
- CrossCodeEval (single-turn completion)
- Any benchmark where tasks don't share a repo

Memory should matter on:
- SWE-Bench Pro (~45 tasks per repo on average) — memory accumulates across tasks within a repo
- Multi-SWE-bench (similar shape) — cross-validates
- SWE-EVO (multi-step evolution) — most direct memory test if TS covered
- LoCoBench long-context scenarios — kk-pruned context vs raw long-context

The **within-repo task-task carryover on SWE-Bench Pro is the cleanest public proxy** for "code-anchored memory persists usefully across coding sessions."

---

## Metrics

Standard per benchmark:

| Metric | Notes |
|---|---|
| **Resolve rate** (primary) | % of tasks where the agent produces a passing patch / valid completion |
| **Tokens consumed** | Per-task total; broken down by exploration vs. implementation if instrumentable |
| **Time to resolution** | Wall time per task |
| **Within-repo learning curve** | For SWE-Bench Pro / Multi-SWE-bench: resolve rate on task K within a repo, plotted against K. Memory should produce an upward slope under C2 that's absent under C0/C1. |
| **Token efficiency vs long-context** | For LoCoBench: tokens used at equivalent resolve rate, kk-pruned vs raw long-context |

---

## Order of operations

1. **CrossCodeEval (TS subset)** — fastest, single-turn, isolates the graph claim. Run C0 + C1. (C2 = C1.) ~1 week.
2. **SWE-Bench Pro (TS subset)** — the credibility win. Run C0 + C1 + C2. ~2 weeks (Docker per task, cost ~$300–500).
3. **Multi-SWE-bench (TS+JS subset)** — peer-reviewed cross-check. Run C0 + C1 + C2. ~1 week (similar harness).
4. **SWE-EVO** — verify TS coverage first. If yes, run the full ladder. ~1–2 weeks.
5. **LoCoBench** — verify TS coverage. If yes, this is where the long-context-vs-graph comparison lives. ~2 weeks.

Total: ~6–10 weeks if all five benchmarks pan out. CrossCodeEval + SWE-Bench Pro alone (3 weeks) is enough to publish a meaningful first round.

---

## What "kk improves" looks like

We don't just run the benchmarks once. We use them as the *guide* for improving kk:

- C0 → C1 gap shows whether the graph tools help. If small, the graph queries the agent gets need redesigning (e.g., better `kk impact` outputs, better surface in `kk precommit`).
- C1 → C2 gap shows whether memory helps. If small, either (a) memories aren't being surfaced at the right time, (b) memory write UX needs improvement so the agent writes more good memories, or (c) the within-repo task ordering doesn't exercise carryover.
- Per-task failure analysis: when C2 fails where C1 succeeds (memory hurt), inspect what memory was surfaced and why it misled. Tune.

The benchmarks become a feedback loop: run → identify weak axis → ship improvement → re-run.

---

## Reporting principles

- **Publish numbers we lose on.** Cherry-picking destroys credibility.
- **Open-source the harness, the kk version pinned, the prompts used.** If we can't show the code we ran, the number is worthless.
- **Version everything.** Tag the kk commit, dataset commit, model versions. Re-run on every kk release.
- **One benchmark, one claim.** Don't cite the SWE-Bench Pro number when arguing about long-context (use LoCoBench for that).
- **Cite what we used, not what would have flattered us.** If we ran with `claude-haiku-4-5` for cost reasons, say so.

---

## Open questions

1. **TS coverage on SWE-EVO and LoCoBench** — need to confirm before committing. If either covers TS, it's a high-priority slot. If neither, drop them.
2. **SWE-Bench Pro cost.** 1,865 tasks × 3 configs × Claude Opus is expensive. Options: (a) full benchmark, accept cost; (b) TS subset only; (c) sample within the TS subset. We probably want (b) — focus the cost on the language we actually support.
3. **Within-repo task ordering for SWE-Bench Pro.** To measure memory carryover honestly, we need to run tasks within a repo in a defined order (chronological by issue date is the natural choice). Random ordering destroys the signal.
4. **Should agent be instructed to write memories?** Two sub-options for C2: (a) "passive" — agent has the tools but isn't told to use them; (b) "instructed" — agent's system prompt tells it to write memories on non-obvious findings. (b) measures the upper bound; (a) measures realistic usage. Probably run both.

---

## Status

| Benchmark | TS verified | Harness built | C0 run | C1 run | C2 run | Published |
|---|---|---|---|---|---|---|
| CrossCodeEval | ✓ | — | — | — | n/a | — |
| SWE-Bench Pro | ✓ | — | — | — | — | — |
| Multi-SWE-bench | ✓ | — | — | — | — | — |
| SWE-EVO | TBD | — | — | — | — | — |
| LoCoBench | TBD | — | — | — | — | — |

---

## The pitch this produces

> kk doesn't run chat-memory benchmarks. We test on public coding benchmarks against real codebases. On CrossCodeEval (TS subset), graph-aware Claude Code (`kk` graph tools enabled) completes N% more cross-file completions than baseline. On SWE-Bench Pro (TS subset), graph alone lifts resolve rate by X%; graph + memory persisting across tasks in the same repo lifts it by Y%. The memory lift specifically shows up as a positive learning curve within a repo — task N+1 benefits from what was written during tasks 1..N. The reproducible harness and pinned kk version are at [github link].
