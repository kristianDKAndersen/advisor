# term-mirror

A self-contained, zero-dependency Node tool that gives you a readable,
copy-paste-friendly HTML view of a live Claude Code session in your browser,
with a text box that sends input back into that session.

It does **not** scrape the terminal (tmux `capture-pane`/`pipe-pane` cannot
work here — Claude Code runs in tmux's alternate-screen buffer, which never
accumulates scrollback; see the prior session's `changes.md` for the proof).
Instead:

- **Output** is sourced by tailing Claude Code's own on-disk session
  transcript: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
- **Input** is injected into the live session via `tmux send-keys`.

## Run it

```
node term-mirror.js
```

This will:

1. Generate a session UUID and launch `claude --session-id <uuid>` inside a
   tmux session named `mirror`.
2. Wait for Claude Code to create its transcript file, then start tailing it.
3. Start an HTTP server on `http://localhost:7879` bound to loopback only.

Open `http://localhost:7879` in your browser to read the conversation
(rendered, readable, and selectable/copyable) and to type new prompts.

To interact with the exact same session directly from a terminal (e.g. the
VS Code integrated terminal), attach to the tmux session term-mirror is
managing:

```
tmux attach -t mirror
```

**Workflow change:** Claude Code now runs *inside* the `mirror` tmux session
that term-mirror manages, not directly in a bare terminal. Anything you type
in the attached tmux pane and anything you type in the browser go to the same
running `claude` process; the browser is just another way in via the
tmux pane's keyboard input.

## Options

```
--port <n>               HTTP port (default 7879)
--session <name>         tmux session name to launch/use (default "mirror")
--attach-existing <uuid> bind to an already-running "claude --session-id <uuid>"
                         instead of launching a new one
--help                   show usage
```

## Rendering

- User messages: prompt blocks.
- Assistant prose (`text` blocks): rendered as markdown — the prominent,
  copyable content.
- Assistant `thinking` blocks: present but collapsed (`<details>`), per the
  "all I see in the terminal" requirement — folded, not dropped.
- `tool_use` / `tool_result`: compact collapsible chips (e.g.
  `Bash: <first line of command>`).
- Pure metadata records (`queue-operation`, `attachment`, `last-prompt`,
  `ai-title`, `mode`, `permission-mode`) are ignored.

The page honors `prefers-color-scheme` (light/dark), uses a centered
~760px reading column, monospace code blocks with preserved whitespace, and
auto-scrolls to the newest message unless you've scrolled up to read
history.

## Security note

The server binds to `127.0.0.1` only (never a non-loopback interface) and
has no authentication. `POST /input` on that loopback socket forwards
arbitrary text as literal keystrokes into the live `claude` tmux pane — this
is inherent to the tool's purpose (bidirectional control of your own local
session) and only reachable by processes on your machine. Do not put this
port behind a reverse proxy or otherwise expose it beyond localhost.

## Tests

```
bun test term-mirror.test.js
```

Covers the two pure functions the tool is built on:

- `parseJsonlDelta(buffer)` — splits a byte buffer into complete JSON
  records plus a buffered partial trailing line.
- `recordToMessage(record)` — normalizes a transcript record into
  `{role, blocks}` or `null` for records that shouldn't be rendered.

Also covers `escapeHtml`/`renderMarkdown` (HTML-escaping happens before any
markdown transformation, so `<`/`>`/quotes in transcript content can never
break or inject into the page).
