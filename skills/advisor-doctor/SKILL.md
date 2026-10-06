---
name: advisor-doctor
description: One-shot diagnosis of a stalled advisor session. Inspects session.json, recent outbox tail, tmux panes, processes, sentinel files. Use when a session appears stuck or unresponsive.
last_edited: 2026-10-06
---

# /advisor-doctor — Session Diagnosis

Diagnose a stalled or unresponsive advisor session by running the diagnostic script:

```bash
bash $CLAUDE_PROJECT_DIR/skills/advisor-doctor/scripts/diagnose.sh --sid $1
```

Present the script's markdown output to the user as-is; it is self-contained.

Usage: `/advisor-doctor <session-id>` (e.g. `/advisor-doctor 1779957900-bc7439`).
