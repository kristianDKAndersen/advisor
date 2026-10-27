---
scope: "lib/ — core advisor library modules: channel, summon, doc-queue, and related utilities"
last_updated_by: "sid:1793109249-9768ee seq:1"
last_updated_ts: "2026-10-27T13:54:30Z"
---

# lib/

Core library modules for the advisor system.

## channel.js

Append-only JSONL message channel and synthesis runner.

- `append()` — atomically appends a message to a channel file under a seq-lock
- `readAfter()` / `readAll()` — read channel messages
- `Tail` — live-tail a channel file with timeout support
- `synthesize` CLI sub-command — called at worker session close to build `modified_files` via worktree-scoped `git diff --name-only HEAD` plus `git ls-files --others`, then enqueues to `~/.advisor/doc-queue.jsonl`; skips enqueue when file list is empty; double try/catch ensures no failure can abort `synthesize`
- `runsRoot()` — resolves the runs directory, honours `ADVISOR_RUNS_ROOT` env override for test isolation
- consumed by `lib/summon.js`, `lib/parallel.js`, `lib/pipeline.js`, `lib/handoff-receiver.js`, `lib/tmux-runner.js`

## summon.js

Provisions and launches worker sessions.

- `provisionCoderWorktree()` — creates an isolated git worktree for coder workers
- `injectWorkerHooks()` — unconditionally injects PostToolUse/SessionStart/Stop hooks for all agent types and sets `ADVISOR_WORKER_HOOKS=1`; there is no allowlist — every summoned agent receives the worker-hooks environment
- `composeBootstrapPrompt()` / `composeTaskBody()` — assembles the task prompt sent to the worker
- Skill bundle merging at lines 501–534 — agent-private skills from `spawns/<agent>/.claude/skills/` are merged into the worker's Claude config at summon time
- consumed by `tests/summon-skill-expand.test.js`, `tests/summon-tier-skills.test.js`, and integration tests

## doc-queue.js

Persistent JSONL queue for doc-agent work items.

- `enqueue()` — appends a new synthesis record; spinlock protects read-modify-write
- `dequeueUnprocessed()` — returns all records not yet marked processed
- `markProcessed()` — marks records processed by `{sid, seq}` key; spinlock-safe against concurrent enqueues
- `queuePath()` — resolves to `~/.advisor/doc-queue.jsonl`
- consumed by `lib/channel.js synthesize` (enqueue) and the doc-agent worker (dequeue/mark)

## lib/hooks/publish-guard.js

PreToolUse hook (Bash) that blocks raw `git`/`gh` publish commands so outward publishes go through `bin/advisor-publish`.

- a string parser, not a sandbox: it guards against careless or prompt-injected agents only
- exit 2 blocks (reason on stderr and stdout); malformed JSON exits 0; an internal error exits 2
- wired into worker sessions by `lib/summon.js` (pinned by `tests/summon-gates.test.js`)

## lib/hooks/worker-auto-close-match.js

Prints `1` when a Bash PostToolUse event is a real, successful `result` send.

- some command segment (split outside quotes/heredocs/comments) runs `channel.js send --type result` to the outbox, and the output has a `#<seq> [result]` marker or the outbox's last line is a result under 10s old

## lib/sentences.js

Markdown-aware sentence splitter shared by `bin/advisor-claims-check` and `bin/advisor-prose-lint`.

- takes `[{line, text}]` entries and returns `[{sentence, line, endLine}]`
- skips code fences (`opts.fences`, default true); strips list/quote/heading markers; joins wrapped paragraph lines; splits on `.` `!` `?` except after `e.g.` / `i.e.` / `vs.`
- a table yields one sentence per body row (`opts.tableRows`, default true)
