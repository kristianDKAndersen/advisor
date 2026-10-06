---
name: observe
description: Canonical pattern for watching worker outboxes — launch ONE bin/advisor-observe listing all in-flight sids as run_in_background, set a mandatory ScheduleWakeup fallback (>=1200s), and never use the Monitor tool. Use whenever you have one or more in-flight workers and need to resume automatically when results arrive.
last_edited: 2026-10-06
allowed-tools:
  - Bash
---

# observe

Canonical background-observe + ScheduleWakeup pattern for monitoring in-flight workers.

## The pattern

**Never use the `Monitor` tool to observe worker outboxes.** Its events cannot resume a suspended turn: ending your turn after starting it ("Wave N in flight. Will report back.") sleeps the session until the user prompts again. Use `run_in_background` Bash + ScheduleWakeup instead.

### Step 1 - Launch ONE observer covering all in-flight sids

Launch ONE `bin/advisor-observe <sid> [<sid>...]` as a `run_in_background` Bash call, listing every in-flight sid. It exits at the FIRST terminal event across the fleet: `result` with non-blocked verdict (exit 0), `result` with `verdict: "blocked"` or an error (exit 1), timeout or usage error, e.g. bare --after with 2+ sids (exit 2), or `--stall-exit` seconds of true silence (exit 3; observe does NOT terminate the worker). Every stdout line carries a `sid`; key off the trailing `{"type":"observe_exit","code":N,"sid":...,"reason":...}` line, not the shell `$?`.

```bash
bin/advisor-observe <sid1> <sid2> --max-wait 1800
```

Flags: `--after <sid>:<seq>` (repeatable, one per sid; a bare `--after <seq>` is legal only with a single sid), `--max-wait <secs>` (default 1800), `--nudge-after <secs>` (default 300; 0 disables the one automatic "status?" nudge), `--stall-exit <secs>` (default 600; 0 disables).

On exit, re-arm ONE fresh observe with the REMAINING sids and their per-sid `--after <sid>:<seq>` cursors.

### Step 2 - Mandatory ScheduleWakeup fallback

Immediately after launching the observer, call ScheduleWakeup with `delaySeconds` of at least 1200. This is not optional: it resumes the session even if the observer exits without surfacing a result.

```
ScheduleWakeup({
  delaySeconds: 1200,
  reason: "re-poll <agent> outbox — <sid> outstanding",
  prompt: "<verbatim user prompt or the /loop sentinel for autonomous mode>"
})
```

### Step 3 - On wakeup: poll, then proceed or re-schedule

Poll each outstanding outbox:

```bash
bun "${ADV:-.}/lib/channel.js" recv --file <outbox> --after <last_seq> --json
```

- All workers delivered `result`: run `/synth` for each result, then move to the next step.
- Some still outstanding: re-run ScheduleWakeup and end the turn. Never end a wakeup turn with another "in flight" message.
- Silence is handled automatically: with the default flags, observe sends one "status?" nudge at 5 minutes (`--nudge-after`). At 10 minutes (`--stall-exit`) it emits `busy` if the worker's runner and pane are alive (`runs/<sid>/runner.json`) and keeps waiting, exiting 3 (`stalled`) only at 30 minutes; if the pane or runner is gone it exits 3 (`dead`) at once. Treat exit 3 as the cue to decide `terminate`-vs-wait.
