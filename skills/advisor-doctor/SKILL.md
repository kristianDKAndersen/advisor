---
name: advisor-doctor
description: One-shot diagnosis of a stalled advisor session. Inspects session.json, recent outbox tail, tmux panes, processes, sentinel files. Use when a session appears stuck or unresponsive.
last_edited: 2026-05-28
---

# /advisor-doctor — Session Diagnosis

Diagnose a stalled or unresponsive advisor session by running the diagnostic script:

```bash
bash $CLAUDE_PROJECT_DIR/skills/advisor-doctor/scripts/diagnose.sh --sid $1
```

Present the script's markdown output to the user directly. No further model
processing is needed — the output is self-contained.

## What it checks

- **session.json** — mtime, `next_action`, and each `decomposition[].status`
- **Outbox tail** — last 5 messages from `channel/outbox.jsonl` (type + from + seq)
- **tmux** — count of sessions matching `advisor-<sid>`
- **Processes** — `pgrep -f <sid>` count
- **Sentinel files** — `/tmp/claude-i-*.done` matches for the sid, `tty.txt` presence

## Usage

```
/advisor-doctor <session-id>
```

Example: `/advisor-doctor 1779957900-bc7439`
