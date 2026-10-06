---
name: spawn-team
description: Spawn a parallel team of coder-worker subagents for a multi-fix coding spec (6+ fixes across disjoint files, or one large bounded territory) - covers the spawn gate, territory map, per-worker brief, and post-spawn conflict detection.
last_edited: 2026-10-06
---

# Spawn Team

You are the master coder. Fan out work to `coder-worker` subagents and reassemble their output without conflicts. Each worker burns its own context and sees only its slice; the cost is coordination (territory map, briefs, verdict parsing, integrity checks), which dominates on small or tightly-coupled specs.

## The spawn gate

Run this gate against the spec. **All four conditions must hold** to spawn a team:

1. **≥3 independent fix groups.** Fixes whose correctness does not depend on each other's outcome. If fix A's correctness depends on B's edit landing first, they belong in the same group.
2. **Disjoint file territories.** You can carve the affected files into groups such that no file appears in more than one group. If a critical file is touched by half the fixes, you cannot disjoint and you should not spawn.
3. **≥6 total fixes** in the master spec. Below this, coordination overhead outweighs parallelism.
4. **No serial-only constraints.** The spec marks no fix as ordering-dependent (e.g., "must land before B5"). Schema migrations, sequential refactors, and fixes that depend on a prior fix's output are serial-only.

If all four hold → **spawn a team** (size determined below).

If exactly one condition fails but you have a single large bounded territory (≥8 mechanical fixes in a self-contained module), → **spawn one worker** to offload that territory and protect your context. You handle the rest solo.

Otherwise → **go solo**. Phase 2 of your main protocol applies.

## Sizing the team (2–8 workers)

Pick the smallest size that gets the job done - each extra worker adds aggregation effort and integrity risk.

| Independent groups | Total fixes | Recommended size |
|--------------------|-------------|------------------|
| 3                  | 6–10        | 2 workers + you  |
| 4–5                | 11–20       | 3–4 workers + you |
| 6–7                | 21–40       | 5–6 workers + you |
| 8+                 | 40+         | 7–8 workers + you |

Always keep one row for `coder-self` - the residual work, integration glue, or the trickiest fixes (even if only "verify the merged result lints cleanly"). Never delegate everything. With uneven groups (one has 15 fixes, others 2), prefer fewer larger workers; a one-fix worker is wasted overhead.

## Pre-spawn: write the territory map

Before spawning, write `$OUTPUT_DIR/territory.md` - the single source of truth for who edits what.

```markdown
| Worker          | Files (no overlap with other rows)                | Fix IDs        |
|-----------------|---------------------------------------------------|----------------|
| coder-self      | src/auth/session.ts, src/auth/token.ts            | B1, B3, W2     |
| coder-worker-1  | src/api/users.ts, src/api/users.test.ts           | B2, W1, N1     |
| coder-worker-2  | src/db/schema.sql, src/db/migrate.ts              | W3, W4         |
| coder-worker-3  | src/ui/Login.tsx, src/ui/SignupForm.tsx           | W5, W6, N2, N3 |
```

**Hard rules** (overlapping territories cause silent merge corruption):

- **Every file appears in exactly one row.** If two workers' fixes touch one file, collapse those fixes into one row.
- **Every fix in the master spec appears in exactly one row** - none unassigned, none duplicated.
- **A fix needing files in two rows is not split.** Move the whole fix to the row that owns more of its context.
- **Tests live with their target:** a fix to `users.ts` and its edit in `users.test.ts` share a row.

Validate the table before spawning:

```bash
bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
  validate "$OUTPUT_DIR/territory.md"
```

It prints any file in two or more rows. If it prints anything, fix the table before spawning.

## Per-worker brief

Spawn each worker with the Agent tool (`subagent_type="coder-worker"`). The brief must include all of these fields, verbatim where noted:

- **`worker_id`** - e.g., `coder-worker-1`; used in the changelog filename and verdict envelope.
- **`file_list`** - absolute paths from your territory map: "Edit ONLY these files: [list]. Any edit to a file outside this list is an integrity violation."
- **`fix_slice`** - the assigned spec items, copied word-for-word from the master spec.
- **`read_context`** - "You may read but NOT edit: [list]" (callers, type definitions, related modules).
- **`output_path`** - `$OUTPUT_DIR/<worker_id>-changes.md`, where the worker writes its changelog.
- **`scope_constraints`** - your scope rules from the master spec, pasted in: the worker cannot see the original spec context.
- **`escalation_rules`** - verbatim: "On edit failure, spec divergence, or any other obstacle, skip the fix and log it in the changelog with a reason. Never halt. Never spawn further subagents."
- **`verdict_envelope`** - verbatim: `Return as your final assistant message a JSON object: {"summary":"...","paths":["..."],"verdict":"complete|partial|blocked"}. Use 'partial' if any fix was skipped; 'blocked' if you could not apply any fix.`

A worker that must guess boundaries will guess wrong, so list every file and paste every fix.

## Spawning: single-turn parallel fan-out

Spawn all workers in one assistant turn (N workers = N Agent calls in that turn); sequential turns serialize them. Workers are single-shot and take no guidance, so do not react to partial progress. While they run, do not edit `coder-self`'s row (reading context files is fine).

## Aggregation (after all workers return)

### 1. Parse each verdict envelope

Extract `summary`, `paths`, and `verdict` from each worker's final message.

- `complete` - all fixes in the slice applied. Accept.
- `partial` - read the changelog at `paths[0]`; skipped IDs become candidates for `coder-self` to retry or for follow-up.
- `blocked` - read the changelog for the reason. Do not silently retry the slice solo; log the block in the master changelog.

### 2. Verify territory integrity

```bash
bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
  verify "$OUTPUT_DIR/territory.md"
```

It compares `git diff --name-only` against the declared territories. A file modified by a worker outside its row is an **integrity violation**: log it under "Integrity violations" with worker_id, file, and the change. Then decide: if the change is legitimate, leave it and document why; if it overstepped scope, undo only that worker's hunks with Edit (read them from `git diff <file>`; never `git checkout` - your prompt bans git mutations) and re-run that fix in `coder-self`.

### 3. Apply the residual `coder-self` row

Run your solo Phase 2 workflow on your reserved row, reading affected files fresh (worker edits may have shifted lines or imports). A glue patch for interacting worker edits (e.g., both updated callers of one function whose signature needs a tweak) belongs in `coder-self` and is logged as such.

### 4. Merge changelogs

Concatenate per-worker `*-changes.md` files into `$OUTPUT_DIR/changes.md`, preserving B/W/N severity order. Annotate each fix with `[applied by coder-worker-N]` or `[applied by coder-self]`.

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

If any worker is `blocked` OR any integrity violation is logged, your master verdict in Phase 4 is `partial`, even if every other fix landed.
