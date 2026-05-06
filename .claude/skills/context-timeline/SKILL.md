---
name: context-timeline
description: Launch the advisor-timeline dashboard — a live, color-coded HTML timeline of all advisor session channel messages. Use when you want to visualize advisor/worker message exchanges across sessions, monitor a running session in real time, or review past session history.
allowed-tools:
  - Bash
---

# context-timeline

Launch the advisor-timeline HTTP server to explore advisor session channel messages
as a color-coded, per-agent timeline with SSE live updates.

## Quick start

```bash
node "$REPO/bin/advisor-timeline" --port 7878
```

Then open **http://localhost:7878/** in a browser.

- Left sidebar: lists every session under `~/.advisor/runs/`
- Main panel: chronological timeline of inbox + outbox messages
- Live updates via SSE — messages appear automatically as they arrive
- Click any message body to expand truncated text

## How to launch from Claude Code

```bash
# Start in the background
node "$REPO/bin/advisor-timeline" --port 7878 &

# Verify it's up
curl -s http://localhost:7878/ | grep -c timeline

# Open in browser (macOS)
open http://localhost:7878/
```

## Stop the server

```bash
kill $(lsof -ti tcp:7878)
```

## Message color coding

| Type       | Color     |
|------------|-----------|
| task       | Blue      |
| progress   | Amber     |
| result     | Green     |
| guidance   | Orange    |
| terminate  | Red       |
| question   | Purple    |

## API endpoints

| Endpoint                              | Description                         |
|---------------------------------------|-------------------------------------|
| `GET /`                               | HTML timeline dashboard             |
| `GET /api/sessions`                   | JSON list of sessions               |
| `GET /api/sessions/:sid/messages`     | JSON messages for a session         |
| `GET /events?sid=:sid&after=:seq`     | SSE stream of new messages          |

## Requirements

- Node.js ≥ 18 (no npm packages required — stdlib only)
- Sessions must exist under `~/.advisor/runs/`
