---
name: context-timeline
description: Launch the advisor-timeline dashboard — a live, color-coded HTML timeline of all advisor session channel messages. Use when you want to visualize advisor/worker message exchanges across sessions, monitor a running session in real time, or review past session history.
last_edited: 2026-10-06
allowed-tools:
  - Bash
---

# context-timeline

Launch the advisor-timeline HTTP server: a live, color-coded per-agent timeline of the inbox and outbox messages of every session under `~/.advisor/runs/`. `bin/summon` auto-starts it on port 7878 (`ADVISOR_TIMELINE_PORT`), so check first and start it only if it is down. Run from the advisor repo root.

```bash
curl -sf http://127.0.0.1:7878/health >/dev/null || node bin/advisor-timeline --port 7878 &
open http://localhost:7878/   # macOS
```

Stop the server: `kill $(lsof -ti tcp:7878)`.
