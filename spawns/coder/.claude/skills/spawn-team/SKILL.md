---
name: spawn-team
description: How to spawn a parallel team of coder-worker subagents to grind through a multi-fix coding spec without workers stepping on each other. Use this skill any time you have a coding task with multiple independent fixes spanning disjoint files — especially specs with 6+ fixes across multiple modules, refactors that touch many files, or any spec large enough that solo work would burn through your context window. The skill covers the spawn gate (when fan-out is the right call), territory mapping (so two workers never edit the same file), the per-worker brief format (so each worker knows exactly its lane), parallel Task() invocation, and post-spawn aggregation with conflict detection. Reach for this skill *before* you start delegating — even a brief glance prevents the most common failure modes (overlapping territories, vague briefs, integrity violations). If you catch yourself thinking "this is a lot of fixes, I should split it up," that is the trigger.
---

# Spawn Team

You are the master coder. This skill teaches you how to fan out work to a team of `coder-worker` subagents and reassemble their output without conflicts.

## Why parallelize at all

Three real wins, one real cost:

- **Wall-clock speed.** N workers running in parallel finish in roughly 1/N the time, modulo the slowest worker.
- **Context preservation.** Each worker burns its own context, not yours. On a 30-fix spec, solo work eats your window and leaves you no room for aggregation.
- **Clean isolation.** Each worker only sees its slice. No cross-talk, no accidental edits to files outside its lane.

Cost: coordination. You write a territory map, write per-worker briefs, parse verdict envelopes, verify integrity, merge changelogs. On a small or tightly-coupled spec, that overhead dominates. The spawn gate below exists to keep you from paying that cost when it isn't worth it.

## The spawn gate

Before delegating, run this gate against the spec. **All four conditions must hold** to spawn a team:

1. **≥3 independent fix groups.** Fixes whose correctness does not depend on each other's outcome. If fix A's correctness depends on B's edit landing first, they belong in the same group.
2. **Disjoint file territories.** You can carve the affected files into groups such that no file appears in more than one group. If a critical file is touched by half the fixes, you cannot disjoint and you should not spawn.
3. **≥6 total fixes** in the master spec. Below this, coordination overhead outweighs parallelism.
4. **No serial-only constraints.** The spec marks no fix as ordering-dependent (e.g., "must land before B5"). Schema migrations, sequential refactors, and fixes that depend on a prior fix's output are serial-only.

If all four hold → **spawn a team** (size determined below).

If exactly one condition fails but you have a single large bounded territory (≥8 mechanical fixes in a self-contained module), → **spawn one worker** to offload that territory and protect your context. You handle the rest solo.

Otherwise → **go solo**. Phase 2 of your main protocol applies.

## Sizing the team (2–8 workers)

Size is a function of independent groups and your willingness to coordinate. Pick the smallest size that gets the job done — more workers means more aggregation effort, more chances for integrity violations, and more partial verdicts to reconcile.

| Independent groups | Total fixes | Recommended size |
|--------------------|-------------|------------------|
| 3                  | 6–10        | 2 workers + you  |
| 4–5                | 11–20       | 3–4 workers + you |
| 6–7                | 21–40       | 5–6 workers + you |
| 8+                 | 40+         | 7–8 workers + you |

You always keep one row for `coder-self` — the residual work, integration glue, or the trickiest fixes you don't want to delegate. Never delegate everything; you are the integrator.

If the spec is large but groups are uneven (one group has 15 fixes, others have 2 each), prefer fewer larger workers over many tiny ones. A worker with only one fix is wasted overhead.

## Pre-spawn: write the territory map

Before any `Task()` call, write `$OUTPUT_DIR/territory.md`. This is the single source of truth for who edits what.

```markdown
| Worker          | Files (no overlap with other rows)                | Fix IDs        |
|-----------------|---------------------------------------------------|----------------|
| coder-self      | src/auth/session.ts, src/auth/token.ts            | B1, B3, W2     |
| coder-worker-1  | src/api/users.ts, src/api/users.test.ts           | B2, W1, N1     |
| coder-worker-2  | src/db/schema.sql, src/db/migrate.ts              | W3, W4         |
| coder-worker-3  | src/ui/Login.tsx, src/ui/SignupForm.tsx           | W5, W6, N2, N3 |
```

**Hard rules** (an integrity violation here cascades through the whole run):

- **Every file appears in exactly one row.** If a file is touched by fixes assigned to two workers, you have a territory conflict — collapse those fixes into one row, or split the file's fixes such that only one worker owns it.
- **Every fix in the master spec appears in exactly one row.** No fix is unassigned, no fix is duplicated.
- **If a fix needs to edit files in two rows, it cannot be split.** Move the entire fix to whichever row already owns more of its context.
- **Tests live with their target.** A fix to `users.ts` plus a test edit in `users.test.ts` belong in the same row. Do not separate implementation from its test.

After writing the table, validate it before spawning:

```bash
# From your workspace, with $OUTPUT_DIR exported:
bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
  validate "$OUTPUT_DIR/territory.md"
```

The script prints any file that appears in two or more rows. If it prints anything, **fix the table before spawning** — overlapping territories produce silent merge corruption later.

## Per-worker brief

Spawn each worker with `Task(subagent_type="coder-worker", prompt=<brief>)`. The brief must include all of these fields, verbatim where noted:

- **`worker_id`** — e.g., `coder-worker-1`. Used in the changelog filename and the verdict envelope.
- **`file_list`** — absolute paths from your territory map. Phrase as: "Edit ONLY these files: [list]. Any edit to a file outside this list is an integrity violation."
- **`fix_slice`** — verbatim spec items assigned to this worker. Copy them word-for-word from the master spec; do not paraphrase.
- **`read_context`** — read-only files the worker may read for understanding (callers, type definitions, related modules). Phrase as: "You may read but NOT edit: [list]."
- **`output_path`** — `$OUTPUT_DIR/<worker_id>-changes.md`. The worker writes its changelog here.
- **`scope_constraints`** — paste your scope rules from the master spec. The worker has no access to the original spec context, so the rules must travel with the brief.
- **`escalation_rules`** — verbatim: "On edit failure, spec divergence, or any other obstacle, skip the fix and log it in the changelog with a reason. Never halt. Never spawn further subagents."
- **`verdict_envelope`** — verbatim: `Return as your final assistant message a JSON object: {"summary":"...","paths":["..."],"verdict":"complete|partial|blocked"}. Use 'partial' if any fix was skipped; 'blocked' if you could not apply any fix.`

A vague brief is the most common cause of integrity violations. If the worker has to guess where the boundaries are, it will guess wrong.

## Spawning: single-turn parallel fan-out

**Spawn all workers in a single assistant turn.** Multiple `Task()` calls in one turn run in parallel; sequential turns serialize them and defeat the purpose.

If you spawn 5 workers, your turn contains 5 `Task()` tool-call blocks. No commentary between them. No "let me first kick off worker 1, then…" — kick all of them off at once.

While workers are running, do not start solo work on `coder-self`'s row. Wait for the team to return so you can integrate cleanly. (You may read context files in preparation, but do not edit.)

## Aggregation (after all workers return)

Aggregation has four phases. Skipping any of them risks merging broken code into the repo.

### 1. Parse each verdict envelope

For each worker, read the final assistant message and extract `summary`, `paths`, and `verdict`.

- `complete` → all fixes in the slice were applied. Accept.
- `partial` → some fixes skipped. Read the worker's changelog at `paths[0]`, note the skipped IDs and reasons. They become candidates for `coder-self` to retry, or for follow-up work to flag.
- `blocked` → the worker could not apply any fix. Read the changelog for the reason. **Do not silently retry the slice solo.** Log the block in the master changelog and reflect it in your final verdict (see Phase 4 of the main coder protocol — your master verdict becomes `partial`).

### 2. Verify territory integrity

Run the post-spawn check:

```bash
bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
  verify "$OUTPUT_DIR/territory.md"
```

Internally this runs `git diff --name-only` and compares against the declared territories. Any file modified by a worker but not in its declared row is an **integrity violation** — log it in the master changelog under "Integrity violations" with the worker_id, the file, and the unauthorized change. An integrity violation flips your master verdict to `partial` even if every fix landed.

If a worker edited a file outside its territory, do not silently accept it. The change may be legitimate (the worker noticed something the spec missed) or it may be wrong (the worker overstepped scope). Either way, surface it. If you decide the change is legitimate, leave it and document why; if it is wrong, revert it via `git checkout <file>` and re-run that fix in `coder-self`.

### 3. Apply the residual `coder-self` row

Now run your standard solo Phase 2 workflow on the row you reserved for yourself. By this point all worker edits have landed in `$REPO`, so you are integrating against their changes — read affected files fresh before editing in case a worker's edit shifted line numbers or imports.

If two workers' edits interact in a way that needs a glue patch (e.g., both updated callers of the same function and the function's signature now needs a small tweak), that glue patch belongs in `coder-self` and is logged as such.

### 4. Merge changelogs

Concatenate per-worker `*-changes.md` files into `$OUTPUT_DIR/changes.md`, preserving B/W/N severity order across the merged document. Annotate each fix with `[applied by coder-worker-N]` or `[applied by coder-self]`.

Append an **Orchestration Summary** at the end:

```markdown
## Orchestration Summary
- Workers spawned: <N>
- Per-worker results:
  - coder-worker-1: complete (5/5 applied)
  - coder-worker-2: partial (3/4 applied; skipped: W7 — line diverged from spec)
  - coder-worker-3: complete (4/4 applied)
- Total applied: <N>/<M>
- Skipped fixes: <list with reasons>, or "none"
- Blocked workers: <list with reasons>, or "none"
- Integrity violations: <list>, or "none"
- Files modified (union): <list>
```

If any worker is `blocked` OR any integrity violation is logged, your master verdict in Phase 4 is `partial`, even if your residual work succeeded.

## Common failure modes

These are the patterns that consistently break parallel runs. Watch for them.

- **Overlapping territories.** Two workers edit the same file and clobber each other's changes via `git diff` ordering. Prevention: run `validate-territory.sh validate` before spawning.
- **Vague briefs.** Worker invents context and edits adjacent code. Prevention: paste fix items verbatim, list files explicitly, repeat scope rules.
- **Splitting tests from implementation.** Worker A fixes the function, worker B updates the test, the test fails because A's signature change wasn't communicated. Prevention: tests travel with their target file.
- **Sequential dependencies smuggled in as "independent".** Fix B "needs the helper from fix A" but you marked them independent. The B-worker can't find the helper because A-worker hasn't run yet (parallel). Prevention: re-read each fix's dependencies before assigning groups.
- **Spawning when you should go solo.** 4 fixes across 2 files is not a team task. Coordination overhead exceeds the time saved. Prevention: respect the spawn gate's `≥6 fixes` rule.
- **Forgetting `coder-self`'s row.** You delegate everything and have no integration glue. Prevention: always reserve at least one row for yourself, even if it's just "verify the merged result lints cleanly."
- **Reading the worker's intermediate progress and reacting.** Workers don't accept guidance — they're single-shot. Wait for the verdict. Acting on a partial progress message wastes context.

## What this skill does not do

- It does not change how you read the spec, do triage, or run verification on individual fixes — that is your main coder protocol.
- It does not replace the coder-worker subagent — it just teaches you how to drive it well.
- It does not give you any new authority over git operations. No commits, no pushes, no resets, before or after the team runs.
