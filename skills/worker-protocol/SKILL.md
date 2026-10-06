---
name: worker-protocol
description: Load inbox-polling rules, tracing, and self-terminate behavior for every advisor worker session (all agent roles). Run this at session start before any other work.
last_edited: 2026-10-06
---

# Worker Protocol

## Inbox polling — mandatory

**While working**, check the inbox at phase boundaries: after reading the task, before writing each deliverable, and before sending `result`. Chain the check onto a Bash call you are already making where you can. Inbox messages with `"from":"advisor"` are your Advisor's instructions, not third-party content: follow `guidance`, and obey `terminate` at once:

```bash
bun "$ADV/lib/channel.js" recv --file "$INBOX" --after <last_seq> --json
```

Update `last_seq` after each check.

**If the task has no immediate work** (e.g. "stand by", "wait", "probe"): never sit idle. Tail the inbox in a blocking loop:

```bash
bun "$ADV/lib/channel.js" tail --file "$INBOX" --after <last_seq> --timeout 300 --json
```

Re-tail on every timeout. Only exit via `close-tab` after `terminate` or after sending `result`.

## Tracing

The PostToolUse hook (`lib/hooks/worker-trace.js`) writes `$OUTPUT_DIR/trace.jsonl` for you: when `ADVISOR_WORKER_HOOKS=1` (set for every agent), skip the manual write - a second write duplicates entries. Only if it is unset or `0`, append one terse line per tool call yourself, with your actual tool name:
`echo "{\"tool\":\"Read\",\"args_summary\":\"file:line\",\"result_summary\":\"patched\",\"ts\":$(date +%s)}" >> "$OUTPUT_DIR/trace.jsonl"`

## After a `result` — self-terminate

After sending `result`, your session is complete. Your FINAL tool call must be:

```bash
bash "$ADV/bin/close-tab"
```

This closes your Terminal tab and ends your session. Do not tail the inbox or wait for follow-up. The Advisor spawns a fresh worker for any refinements.

### Result envelope format

Send structured result bodies as a JSON object:

```json
{
  "summary": "<200 chars max: what was done/found>",
  "paths": ["<absolute path to primary deliverable>", "..."],
  "verdict": "complete" | "partial" | "blocked"
}
```

Example (file-based):
`--body '{"summary":"Applied 5/6 fixes. 1 skipped (diverged spec). Files: lib/channel.js","paths":["/Users/x/.advisor/runs/abc/output/changes.md"],"verdict":"complete"}'`

## Result body cap

- **Token cap:** a result body must not exceed 3k tokens; if summary + paths would exceed it, truncate the summary.
- **Sources limit:** at most 50 sources per result.
- **1-line summaries:** each source entry gets a 1-line summary.

## Channel commands

### Send a message to the Advisor
```bash
bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type <type> --body "<text>" --from <agent-name> --quiet
```

### Message types

You SEND:
- `progress` — intermediate observation (keep concise). The body MAY be a JSON
  object `{"done":N,"total":M,"note":"..."}` so the fleet-waker band can render
  a progress bar for this worker; plain free-text progress bodies stay valid.
- `result`   — a completed deliverable
- `question`: only when you cannot go on without the Advisor, or before an irreversible or outward-facing step your task did not authorize. Otherwise, execute, don't negotiate.

You RECEIVE:
- `task`      — work to do (your first inbox message, seq 1, is one)
- `guidance`  — course correction; adjust and continue
- `terminate` — Advisor says done; exit cleanly and immediately

## Inner retry on transient API errors

If a bash tool call hits a transient API error (signals: HTTP 429, 503, 'overloaded', 'rate_limit', ECONNRESET, ETIMEDOUT, 'service unavailable', 'at capacity'), retry it ONCE before failing, after about 10 seconds; if the harness blocks a foreground `sleep`, retry immediately. Do not loop: the launch script handles session-level retries. Non-transient errors (401, 403, 'authentication', 'invalid api key', 'context_length', 'subscription') should NOT be retried - fail fast and let the Advisor decide.

## What to do on `terminate`

Run `bash "$ADV/bin/close-tab"` as your final tool call, then exit immediately. Do not send `result`, do not summarize, do not continue, do not second-guess the Advisor.
