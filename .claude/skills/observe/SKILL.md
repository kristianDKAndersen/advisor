---
name: observe
description: Canonical pattern for watching worker outboxes — launch bin/advisor-observe per worker as run_in_background, set a mandatory ScheduleWakeup fallback (>=1200s), and never use the Monitor tool. Use whenever you have one or more in-flight workers and need to resume automatically when results arrive.
allowed-tools:
  - Bash
---

# observe

Canonical background-observe + ScheduleWakeup pattern for monitoring in-flight workers.

## The pattern

**Critical constraint: do NOT use the `Monitor` tool to observe worker outboxes.**
Monitor is a within-turn event pump — its events cannot resume a suspended turn. If you end your turn after starting Monitor ("Wave N in flight. Will report back."), the session sleeps indefinitely until the user prompts you again. This has caused confirmed failures. Use `run_in_background` Bash + ScheduleWakeup instead.

### Step 1 — Launch observer(s) as background processes

For each in-flight worker, launch `bin/advisor-observe` as a `run_in_background` Bash call. It exits on `result` (exit 0), `error` (exit 1), or timeout (exit 2).

```bash
# Single worker
bin/advisor-observe <sid> --max-wait 1800 | jq -c .
```

Flags: `--after <seq>` (start cursor, default 0), `--max-wait <secs>` (default 1800), `--poll <ms>` (default 1000).

For multiple workers, launch one `run_in_background` call per worker — each observer tails its own outbox.

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
- If a worker is silent for 10 minutes across wakeup cycles: send one `guidance` nudge ("status?"), then `terminate` if still silent after the next cycle.

Do not end the wakeup turn with another "in flight" message — either poll + proceed, or schedule the next wakeup.

## Why not Monitor?

| Tool | Resumes suspended turn? | Safe to use? |
|------|------------------------|--------------|
| `Monitor` | No — events fire within the turn only | No |
| `run_in_background` + ScheduleWakeup | Yes — wakeup re-enters the session | Yes |

## Quick-reference checklist

- [ ] `bin/advisor-observe <sid>` launched as `run_in_background`
- [ ] ScheduleWakeup called with `delaySeconds >= 1200`
- [ ] Monitor tool NOT used
- [ ] On wakeup: poll outbox, then either proceed or re-schedule
