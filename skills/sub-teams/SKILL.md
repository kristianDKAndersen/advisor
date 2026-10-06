---
name: sub-teams
description: Split the current advisor task into 2-10 independent subtasks and run them in parallel with a delegator plus teammates. Use for large, independent, parallelizable work only.
last_edited: 2026-10-06
---
# /sub-teams - Parallel Sub-Team Execution

Use this only when the task splits into 2 or more independent subtasks that each need real work. For one sequential chain, a single-file change or fewer than 2 independent subtasks, do the work directly and say so in your result.

Run Steps 1-3 in one Bash invocation, or write the exports to "$OUTPUT_DIR/sub-team-env.sh" and source it at the top of every later Bash call: shell variables do not persist between Bash calls.

## Step 1 — Pre-decompose the advisor task

Read your advisor inbox task. Decompose it into N atomic subtasks (N ≥ 2, ≤ 10).

Each subtask must match this schema:
```json
{
  "id": "t1",
  "description": "<one sentence: what to do>",
  "input": {
    "description": "<same as above>",
    "context": "<files to read, symbols to find, constraints — empty string if none>",
    "goal": "<what done looks like>"
  },
  "deps": [],
  "status": "pending",
  "claimed_by": null,
  "claimed_at": null,
  "assigned_teammate": null,
  "output": null,
  "error": null,
  "completed_at": null
}
```

Assign tasks to teammates round-robin: `teammate-1`, `teammate-2`, ... (use at least 2 teammates).
Set `assigned_teammate` per round-robin assignment.

Determine your teammate roles list (e.g. `["teammate-1","teammate-2"]`).

Write the task array to a shell variable:
```bash
TASKS_JSON='[
  {"id":"t1","description":"...","input":{...},"deps":[],"status":"pending","claimed_by":null,"claimed_at":null,"assigned_teammate":"teammate-1","output":null,"error":null,"completed_at":null},
  ...
]'
```

Also prepare the state JSON:
```bash
RUN_ID="sub-$(date +%s)-$$"
RUN_DIR="$OUTPUT_DIR/sub-team-runs/$RUN_ID"
TEAMMATE_ROLES='["teammate-1","teammate-2"]'
STATE_JSON="{\"run_id\":\"$RUN_ID\",\"phase\":\"initializing\",\"teammate_roles\":$TEAMMATE_ROLES,\"ts_started\":$(date +%s),\"ts_updated\":$(date +%s),\"done_roles\":[],\"stalls\":[]}"
```

## Step 2 — Initialize the run directory

```bash
mkdir -p "$RUN_DIR"
bun "$ADV/sub-teams/lib/init.js" \
  --run-dir "$RUN_DIR" \
  --state "$STATE_JSON" \
  --tasks "$TASKS_JSON"
```

Verify exit 0 and `{"ok":true,...}` in output.

## Step 3 — Build role prompts

```bash
TEAMMATE_ROLES_CSV="teammate-1,teammate-2"  # comma-separated, matching the roles in TEAMMATE_ROLES above
bun "$ADV/sub-teams/lib/build-prompts.js" \
  --run-dir "$RUN_DIR" \
  --run-id "$RUN_ID" \
  --teammate-roles "$TEAMMATE_ROLES_CSV" \
  > "$RUN_DIR/role-prompts.json"
```

Read `$RUN_DIR/role-prompts.json` with the Read tool. Pass each role prompt's text verbatim as the `prompt` of its Agent call; shell variables cannot be expanded inside tool parameters.

## Step 4 — Spawn delegator and all teammates in ONE parallel Agent call

**MANDATORY:** Spawn ALL agents (delegator + every teammate) in a SINGLE message with multiple Agent tool calls (formerly the Task tool). Sequential spawning makes the delegator time out waiting for teammates that have not started.

Each Agent call MUST include `model: "<value>"` from the Sub-Team Mode section of your bootstrap prompt (default `model: "sonnet"` if it names none). Use the same value for the delegator and every teammate.

One call per role, all in the same message:

- Agent 1: `description="sub-team delegator"`, `prompt=<delegator prompt text>`, `model=<sub-team-model>`
- Agent 2: `description="sub-team teammate-1"`, `prompt=<teammate-1 prompt text>`, `model=<sub-team-model>`
- Agent 3: `description="sub-team teammate-2"`, `prompt=<teammate-2 prompt text>`, `model=<sub-team-model>`

Wait for all Agent calls to complete before proceeding to Step 5.

## Step 5 — Read final result and apply post-run protocol

```bash
cat "$RUN_DIR/state.json"
```

Parse `state.json`:
- `final_result.summaries`: array of `{task_id, input, output}` for done tasks
- `final_result.failures`: array of `{task_id, input, error, attempted_by}` for failed tasks
- `final_result.counts`: `{total, done, failed, stalled_reclaimed}`

### §4.1 Post-run protocol

Treat an absent `schema_version` in run artifacts as version `0` (legacy).

**5.1** If `phase == "done"` and `failures.length == 0`:
  - Verdict: `complete`
  - Summarize results from `summaries[].output.result`

**5.2** If `phase == "done"` and `failures.length > 0`:
  - Verdict: `partial`
  - List each failure: `task_id`, `error`, `attempted_by`
  - Summarize completed tasks from `summaries[].output.result`

**5.3** If `phase == "failed"`:
  - Verdict: `blocked`
  - Report the phase and any available partial results

**5.4** Report the sub-team result in your advisor channel result envelope with:
- `body.sub_team_run_id`: `$RUN_ID` (top-level)
- `body.meta.sub_team`: `{"run_id": "$RUN_ID", "teammate_count": N, "tasks_done": N, "tasks_failed": N}`
- `body.verdict`: `complete` | `partial` | `blocked`

## Step 6 — Citation

End your result with:

> sub-teams run `<run_id>` — run_dir=`<run_dir>`
