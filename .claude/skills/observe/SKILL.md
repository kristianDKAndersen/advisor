---
name: observe
description: Canonical pattern for watching worker outboxes — launch ONE bin/advisor-observe listing all in-flight sids as run_in_background, set a mandatory ScheduleWakeup fallback (>=1200s), and never use the Monitor tool. Use whenever you have one or more in-flight workers and need to resume automatically when results arrive.
allowed-tools:
  - Bash
---

# observe

Canonical background-observe + ScheduleWakeup pattern for monitoring in-flight workers.

## The pattern

**Critical constraint: do NOT use the `Monitor` tool to observe worker outboxes.**
Monitor is a within-turn event pump — its events cannot resume a suspended turn. If you end your turn after starting Monitor ("Wave N in flight. Will report back."), the session sleeps indefinitely until the user prompts you again. This has caused confirmed failures. Use `run_in_background` Bash + ScheduleWakeup instead.

### Step 1 — Launch one observer covering all in-flight sids

Invocation is positional and variadic: `bin/advisor-observe <sid> [<sid>...]`. Launch ONE `bin/advisor-observe` as a `run_in_background` Bash call, listing every in-flight sid — one resident process covers the whole fleet. It blocks until the FIRST terminal event across the fleet, then exits: `result` with non-blocked verdict (exit 0), `result` with `verdict: "blocked"` or an error (exit 1), timeout (exit 2), or `--stall-exit` seconds of true silence (exit 3, reason `stalled`; observe does NOT terminate the worker). Every stdout line carries a `sid` field, since a single exit code can't say which worker it refers to, and every exit also emits a trailing `{"type":"observe_exit","code":N,"sid":...,"reason":...}` line - key off that line, not the shell `$?`.

```bash
# Single worker
bin/advisor-observe <sid> --max-wait 1800

# Multiple workers — one process, all sids
bin/advisor-observe <sid1> <sid2> --max-wait 1800
```

Flags: `--after <sid>:<seq>` (repeatable, one per sid), or a bare `--after <seq>` (legal only for a single sid — a usage error, exit 2, with 2+ sids), `--max-wait <secs>` (default 1800), `--poll <ms>` (default 1000), `--verbose` (restores filtered `progress` messages; `stalled`/`heartbeat` lines are always emitted), `--nudge-after <secs>` (default 300; 0 disables - observe auto-sends one "status?" guidance nudge to a silent worker), and `--stall-exit <secs>` (default 600; 0 disables - observe exits 3 after this much true silence without terminating the worker).

On exit, re-arm ONE fresh observe with the REMAINING sids and their per-sid `--after <sid>:<seq>` cursors. Single-sid invocation is fully backwards compatible.

### Step 2 — Mandatory ScheduleWakeup fallback

Immediately after launching the background observer(s), call ScheduleWakeup with at least 1200 seconds. This is not optional — it guarantees the session resumes even if the observer exits without surfacing a result in your context.

```
ScheduleWakeup({
  delaySeconds: 1200,
  reason: "re-poll <agent> outbox — <sid> outstanding",
  prompt: "<verbatim user prompt or the /loop sentinel for autonomous mode>"
})
```

Use a delay ≥ 1200 s (20 min). Shorten only if the task is known to be fast and you have confirmed the worker is already running.

### Step 3 — On wakeup: poll then proceed or re-schedule

When the wakeup fires, poll each outstanding outbox:

```bash
bun lib/channel.js recv --file <outbox> --after <last_seq> --json
```

- If all workers have delivered `result`: proceed to `/synth` for each result, then move to the next step.
- If some workers are still outstanding: re-run ScheduleWakeup and end the turn.
- Silence handling is now automatic: with the default `--nudge-after 300`/`--stall-exit 600`, observe sends the one "status?" `guidance` nudge itself at 5 minutes and exits 3 (reason `stalled`) at 10 minutes without terminating the worker. Treat exit 3 as the signal to decide `terminate`-vs-wait.

Do not end the wakeup turn with another "in flight" message — either poll + proceed, or schedule the next wakeup.

## Why not Monitor?

| Tool | Resumes suspended turn? | Safe to use? |
|------|------------------------|--------------|
| `Monitor` | No — events fire within the turn only | No |
| `run_in_background` + ScheduleWakeup | Yes — wakeup re-enters the session | Yes |

## Quick-reference checklist

- [ ] `bin/advisor-observe <sid> [<sid>...]` launched as ONE `run_in_background` process covering all in-flight sids
- [ ] ScheduleWakeup called with `delaySeconds >= 1200`
- [ ] Monitor tool NOT used
- [ ] On wakeup: poll outbox, then either proceed or re-schedule
