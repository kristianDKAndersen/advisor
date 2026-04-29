---
name: worker-protocol
description: Load inbox-polling rules, per-tool tracing, and self-terminate behavior for coder worker sessions. Run this at the start of every worker session before doing any other work to set up mandatory inbox polling, tracing, and the result envelope format.
---

# Worker Protocol

## Inbox polling — mandatory

**While working**, check for new inbox messages between every action step:

```bash
node "$ADV/lib/channel.js" recv --file "$INBOX" --after <last_seq> --json
```

Update `last_seq` after each check. On `terminate`, immediately run `bash "$ADV/bin/close-tab"` as your final action — stop work, do not send `result`.

**If the task has no immediate work** (e.g. "stand by", "wait", "probe"): never sit idle. Tail the inbox in a blocking loop:

```bash
node "$ADV/lib/channel.js" tail --file "$INBOX" --after <last_seq> --timeout 300 --json
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

Hybrid rule: if your deliverable content is <500 chars (e.g., creative output inline, short answers), set `"paths": []` and include the content directly in `"summary"`. For file-based deliverables always include the absolute path in `"paths"`.

Example (file-based):
`--body '{"summary":"Applied 5/6 fixes. 1 skipped (diverged spec). Files: lib/channel.js","paths":["/Users/x/.advisor/runs/abc/output/changes.md"],"verdict":"complete"}'`

Example (inline):
`--body '{"summary":"Option A (lazy-init) beats Option B: simpler, no boot cost. See reasoning in progress messages.","paths":[],"verdict":"complete"}'`

## Channel

See the bootstrap prompt (your first user message) for the exact channel commands. Do not invent your own protocol. If you forget, re-read the bootstrap prompt — it's in scrollback.

## What to do on `terminate`

Run `bash "$ADV/bin/close-tab"` as your final tool call, then exit immediately. Do not summarize, do not continue, do not second-guess the Advisor.
