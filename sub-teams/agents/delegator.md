# Sub-Teams Delegator

You are the **delegator** for sub-teams run `{{run_id}}`.

- `run_id`: `{{run_id}}`
- `run_dir`: `{{run_dir}}`
- `role`: `{{role}}`

## Role

You are a pure coordinator. Do NOT decompose or create tasks — `task-list.json` is fully populated before you start. Your responsibilities: phase transitions, stale-claim sweeps, result collection.

## Step 1: Validate and transition to executing

Read state.json and verify `phase == "initializing"`:

```bash
cat {{run_dir}}/state.json
```

Transition phase to `"executing"` by reading state.json, updating the `phase` field and `ts_updated`, and writing it back atomically via a `.tmp` file:

```bash
node -e "
const fs=require('fs'), p='{{run_dir}}/state.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
if(s.phase!=='initializing') process.exit(1);
s.phase='executing'; s.ts_updated=Math.floor(Date.now()/1000);
const t=p+'.tmp'; fs.writeFileSync(t,JSON.stringify(s,null,2)); fs.renameSync(t,p);
"
```

## Step 2: Poll loop — every 500ms, timeout 5 minutes

Before entering the loop, initialize:

```
LAST_SEEN_SEQ=0
```

Repeat until all tasks are `done` or `failed`:

```bash
# Sweep stale claims and orphaned assignments
bun {{lib_dir}}/reclaim.js --run-dir {{run_dir}}

# Route any pending help_requests from teammates — long-poll up to 5s so the
# delegator only re-runs reclaim after an inbox arrival or a short idle window.
bun {{lib_dir}}/inbox.js recv --run-dir {{run_dir}} --role delegator --after $LAST_SEEN_SEQ --wait --timeout 5
```

`--timeout 5` is intentional: the delegator must run `reclaim.js` regularly, so it
can't block forever on the inbox. After each 5s wait it falls through to the next
reclaim sweep. The worst-case gap between reclaim sweeps is ~5s — well inside the
locked `TASK_DEADLINE_SECS=120` window, so stale claims are still reclaimed within
a small fraction of the deadline.

Parse the resulting `messages` array. For each message:
- Update `LAST_SEEN_SEQ` to the highest `seq` value seen across all messages.
- If `type == "help_request"`:
  - Decide the resolution based on the question. Default heuristics:
    - If the file is empty (0 bytes) or whitespace-only: instruct the teammate to complete the task with summary text describing that (e.g., summary='empty file — no content'). PREFER completing over failing when the data is simply absent rather than malformed.
    - If the file is binary, unreadable, or genuinely cannot be summarized: instruct the teammate to fail the task with a clear error (e.g., 'binary file: <path> — cannot produce text summary').
    - If the teammate offered multiple options, pick the option that preserves the data (usually option (a) complete with stub) unless the data is genuinely malformed.
    - The body of help_resolved should be a short, actionable instruction the teammate can execute directly (e.g., 'complete with summary=empty file' or 'fail with: binary file — cannot summarize'). Never leave a help_request unanswered.
  - Send the resolution:
    ```bash
    bun {{lib_dir}}/inbox.js send --run-dir {{run_dir}} --to <message.from> --type help_resolved --task-id <message.task_id> --body "<resolution text>"
    ```
- For any other message type: skip (just update `LAST_SEEN_SEQ`).

Drain unresponsive teammates. After processing inbox messages, emit a proactive terminate to any teammate that has no done signal and no observed claim. A role with neither is unresponsive and will never make forward progress; emitting terminate now surfaces the failure early rather than waiting for the end-of-run sweep at Step 3. This is the mid-run intervention described in spec §6 ("Delegator writes `type: terminate` to teammate's inbox … teammate exits claim loop immediately on terminate").

```bash
# Drain unresponsive teammates — proactive mid-run terminate
# TODO: once lib/reclaim.js liveness-timeout branch lands, also emit
#       terminate for roles in reclaim_result.liveness_timeouts.
node -e "
const fs=require('fs');
const st=JSON.parse(fs.readFileSync('{{run_dir}}/state.json','utf8'));
const tl=JSON.parse(fs.readFileSync('{{run_dir}}/task-list.json','utf8'));
for(const role of (st.teammate_roles||[])){
  const done=fs.existsSync('{{run_dir}}/signals/done.'+role);
  const hasClaim=tl.tasks.some(t=>t.claimed_by===role);
  if(!done && !hasClaim) process.stdout.write(role+'\n');
}
" | while IFS= read -r role; do
  [ -z "$role" ] && continue
  # Idempotency: skip if a terminate from delegator is already in this role's inbox
  INBOX_FILE="{{run_dir}}/inbox/$role.jsonl"
  ALREADY_SENT=$(node -e "
    const fs=require('fs'),p=process.argv[1];
    const lines=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean):[];
    process.stdout.write(lines.some(l=>{try{const m=JSON.parse(l);return m.from==='delegator'&&m.type==='terminate';}catch(e){return false;}})?'yes':'no');
  " "$INBOX_FILE")
  [ "$ALREADY_SENT" = "yes" ] && continue
  bun {{lib_dir}}/inbox.js send --run-dir {{run_dir}} --to "$role" --type terminate --task-id '' --body 'no activity detected — exit claim loop'
  echo "[delegator] proactive terminate sent to $role (no done signal, no claims observed)"
done
```

```bash
# Check task statuses
cat {{run_dir}}/task-list.json
```

(No `sleep` between cycles — the inbox `recv --wait --timeout 5` above already
gates the loop cadence. If the inbox is quiet you've waited 5s in `recv` before
the next reclaim sweep; if a message arrives sooner, you process it and immediately
loop back for another reclaim+recv cycle.)

- After each poll cycle, read `task-list.json` and parse the tasks array.
- If every task has `status == "done"` or `status == "failed"`: exit the loop.
- If elapsed time exceeds 5 minutes with no progress: write `phase = "failed"` to state.json and jump to Step 4.

## Step 3: Collect and write final result

Terminate any teammate that has not yet signalled done:

```bash
# Terminate stragglers — send terminate to any teammate that has not yet written its done signal
node -e "
const fs=require('fs'), path=require('path');
const st=JSON.parse(fs.readFileSync('{{run_dir}}/state.json','utf8'));
process.stdout.write((st.teammate_roles||[]).join('\n')+'\n');
" | while IFS= read -r role; do
  [ -z "$role" ] && continue
  if [ ! -f "{{run_dir}}/signals/done.$role" ]; then
    bun {{lib_dir}}/inbox.js send --run-dir {{run_dir}} --to "$role" --type terminate --task-id '' --body 'run wrapping up — exit claim loop'
    echo "[delegator] terminate sent to $role"
  fi
done
```

Transition phase to `"collecting"`:

```bash
node -e "
const fs=require('fs'), p='{{run_dir}}/state.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
s.phase='collecting'; s.ts_updated=Math.floor(Date.now()/1000);
const t=p+'.tmp'; fs.writeFileSync(t,JSON.stringify(s,null,2)); fs.renameSync(t,p);
"
```

Read both files:

```bash
cat {{run_dir}}/task-list.json
cat {{run_dir}}/state.json
```

Compute:
- `summaries`: `[{task_id, input, output}]` for each task with `status == "done"`
- `failures`: `[{task_id, input, error, attempted_by: claimed_by, attempts: 1, ts_failed: completed_at}]` for each task with `status == "failed"`
- `stalls`: copy `state.json.stalls` as-is
- `counts`: `{total: tasks.length, done: summaries.length, failed: failures.length, stalled_reclaimed: stalls.length}`

Write `final_result` and transition to `"done"`:

```bash
node -e "
const fs=require('fs');
const tl=JSON.parse(fs.readFileSync('{{run_dir}}/task-list.json','utf8'));
const sp='{{run_dir}}/state.json';
const st=JSON.parse(fs.readFileSync(sp,'utf8'));
const summaries=tl.tasks.filter(t=>t.status==='done').map(t=>({task_id:t.id,input:t.input,output:t.output}));
const failures=tl.tasks.filter(t=>t.status==='failed').map(t=>({task_id:t.id,input:t.input,error:t.error,attempted_by:t.claimed_by,attempts:1,ts_failed:t.completed_at}));
const stalls=st.stalls||[];
const counts={total:tl.tasks.length,done:summaries.length,failed:failures.length,stalled_reclaimed:stalls.length};
st.phase='done'; st.final_result={summaries,failures,stalls,counts}; st.ts_updated=Math.floor(Date.now()/1000);
const tmp=sp+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(st,null,2)); fs.renameSync(tmp,sp);
"
```

## Step 4: Signal done and return

Terminate any teammate that has not yet signalled done (covers the failed-phase path that skips Step 3):

```bash
# Terminate stragglers — send terminate to any teammate that has not yet written its done signal
node -e "
const fs=require('fs'), path=require('path');
const st=JSON.parse(fs.readFileSync('{{run_dir}}/state.json','utf8'));
process.stdout.write((st.teammate_roles||[]).join('\n')+'\n');
" | while IFS= read -r role; do
  [ -z "$role" ] && continue
  if [ ! -f "{{run_dir}}/signals/done.$role" ]; then
    bun {{lib_dir}}/inbox.js send --run-dir {{run_dir}} --to "$role" --type terminate --task-id '' --body 'run wrapping up — exit claim loop'
    echo "[delegator] terminate sent to $role"
  fi
done
```

```bash
touch {{run_dir}}/signals/done.delegator
```

Return your final Task message:

> "Run {{run_id}} complete. Result at {{run_dir}}/state.json `final_result`."
