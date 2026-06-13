---
scope: "lib/ — core advisor library modules: channel, summon, doc-queue, and related utilities"
last_updated_by: "sid:1781303323-2aa9ef seq:3"
last_updated_ts: "2026-06-13T15:15:44Z"
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
- `injectWorkerHooks()` — injects per-worker hook configuration; `doc-agent` is in `WORKER_HOOKS_ALLOWLIST` (line 578) so it receives the worker-hooks environment
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
