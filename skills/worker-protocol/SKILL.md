---
name: worker-protocol
description: Load inbox-polling rules, per-tool tracing, and self-terminate behavior for coder worker sessions. Run this at the start of every worker session before doing any other work to set up mandatory inbox polling, tracing, and the result envelope format.
---

# Worker Protocol

## Inbox polling — mandatory

**While working**, check for new inbox messages between every action step:

```bash
bun "$ADV/lib/channel.js" recv --file "$INBOX" --after <last_seq> --json
```

Update `last_seq` after each check. On `terminate`, immediately run `bash "$ADV/bin/close-tab"` as your final action — stop work, do not send `result`.

**If the task has no immediate work** (e.g. "stand by", "wait", "probe"): never sit idle. Tail the inbox in a blocking loop:

```bash
bun "$ADV/lib/channel.js" tail --file "$INBOX" --after <last_seq> --timeout 300 --json
```

Re-tail on every timeout. Only exit via `close-tab` after `terminate` or after sending `result`.

## Tracing

After each tool call, append one JSON line to `$OUTPUT_DIR/trace.jsonl` with shape `{tool, args_summary, result_summary, ts}`.
Example: `echo "{\"tool\":\"Read\",\"args_summary\":\"file:line\",\"result_summary\":\"patched\",\"ts\":$(date +%s)}" >> "$OUTPUT_DIR/trace.jsonl"` # substitute your actual tool name in the echo command
Keep entries terse — one line per tool call.

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
  "summary": "<≤200 char outcome — what was done/found>",
  "paths": ["<absolute path to primary deliverable>", "..."],
  "verdict": "complete" | "partial" | "blocked"
}
```

Example (file-based):
`--body '{"summary":"Applied 5/6 fixes. 1 skipped (diverged spec). Files: lib/channel.js","paths":["/Users/x/.advisor/runs/abc/output/changes.md"],"verdict":"complete"}'`

## Result body cap

Keep result bodies concise to avoid channel bloat and token waste.

- **Token cap:** Result body must not exceed 3k tokens (3000 tokens). If your summary + paths would exceed the cap, truncate the summary.
- **Sources limit:** Include at most 50 sources in any result. Do not list more than 50 sources in a single result message.
- **1-line summaries:** Each source entry must have a 1-line summary. Multi-line descriptions are not allowed per source.

## Channel commands

### Send a message to the Advisor
```bash
bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type <type> --body "<text>" --from <agent-name> --quiet
```

### Message types

You SEND:
- `progress` — intermediate observation (keep concise)
- `result`   — a completed deliverable
- `question` — only if truly blocked; the pattern is *execute, don't negotiate*

You RECEIVE:
- `task`      — work to do (your first inbox message, seq 1, is one)
- `guidance`  — course correction; adjust and continue
- `terminate` — Advisor says done; exit cleanly and immediately

## Inner retry on transient API errors

If a bash tool call hits a transient API error (signals: HTTP 429, 503, 'overloaded', 'rate_limit', ECONNRESET, ETIMEDOUT, 'service unavailable', 'at capacity'), retry ONCE after sleeping 10 seconds before failing. Non-transient errors (401, 403, 'authentication', 'invalid api key', 'context_length', 'subscription') should NOT be retried — fail fast and let the Advisor decide.

This is a one-shot retry. Do not loop. The outer launch script already handles full session-level retries.

## What to do on `terminate`

Run `bash "$ADV/bin/close-tab"` as your final tool call, then exit immediately. Do not summarize, do not continue, do not second-guess the Advisor.
