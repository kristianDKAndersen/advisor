---
scope: "lib/ — core advisor library modules: channel, summon, doc-queue, handover, maintenance, the herdr worker backend and related utilities"
last_updated_by: "sid:1794235517-c19d4b seq:1"
last_updated_ts: "2026-11-09T14:46:30Z"
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

## handover.js

Shared handover-file module: header parser, legacy resolved rule, header rewrite and atomic file helpers. CommonJS, `fs` + `path` only, so the node-run SessionStart hook can load it through `lib/maintenance.js`.

- Header: a `---` fenced block within the first 40 lines with keys `status`, `created`, `sid`, `resolved`, `outcome`, `archived`, `archive_reason` (`HEADER_KEYS`). `classifyContent()` returns `kind` (`header`, `legacy`, `invalid`, `empty`), `status` (`open`/`resolved`) and, for invalid files, `reason` (e.g. `unclosed-header`, `bad-status`, `bad-created`, `future-created`).
- Legacy files (no leading `---`) resolve only on an anchored `FINAL OUTCOME` line (`LEGACY_RESOLVED_RE`); a mid-line mention stays open. Header files never resolve from the body.
- `applyHeaderUpdates()` rewrites only the named keys and keeps body bytes identical; `renderHeader()` writes keys in fixed order.
- `atomicReplace()` and `createExclusive()` write a same-directory `.hv-tmp.*` file and rename it into place. They never use `link()` (hard links fail on exFAT/SMB). Reads never follow symlinks.
- `moveToArchive()` moves a file into `plans/_archive/`. `resolveHandover()` sets a header file to resolved, or appends a legacy `FINAL OUTCOME:` line; it is check-then-act, so an archive or body edit landing between recheck and rename can race (accepted residual, plan D6).
- Thresholds: `STALE_OPEN_S` 30d, `STALE_WARN_S` 7d, `RESOLVED_ARCHIVE_S` 24h, `EMPTY_GRACE_S` 60s, `FUTURE_SKEW_S` 300s, `MAX_BYTES` 1 MiB.
- `isArchiveDue(h, now)` — the one archive-selection rule both archivers use, on a `scanItems` item (re-exported by `maintenance.js`). Resolved: due once `now` is more than 24h past `resolvedMs`. Open: due once `now` is more than 30d past the later of `createdMs` and mtime. mtime is clamped to `now`, so a future mtime counts as edited now.
- consumed by `lib/maintenance.js` (`require('./handover')`), `bin/handover-resolve` (`resolveHandover`) and `bin/handover-write` (`createExclusive`, `renderHeader`)

## maintenance.js

Testable selection and archiving logic for the SessionStart hook (`.claude/hooks/session-start.js`, which loads it with `require`). Every function is defensive: filesystem errors degrade to an empty list, `null` or 0 moved, so the hook never throws.

- `pickLastSession()` — newest run dir with a parseable `session.json`, skipping `plans` and `_archive`
- `scanItems()` — the one non-recursive read of `plans/` handover names. With more than 1000 names it reads the newest `SCAN_CAP` (500) and the oldest 500, so reports see the newest and archivers reach the oldest; with 1000 or fewer it reads them all. A symlinked `plans/` returns `error: 'ELOOP'` and no items.
- `listHandovers()` / `scanHandovers()` — `listHandovers()` is `scanItems().items`. `scanHandovers(runsRoot, now, opts)` classifies a pre-scanned `opts.items` (or scans itself) and returns `openCount`, `staleCount` (open >7d by `createdMs`), `newestOpen`, invalid reasons and `error`
- `newestUnresolvedHandover()` — path of the newest open handover, or `null`
- `archiveResolvedHandovers()` — moves resolved handovers older than 24h into `plans/_archive/` (header gets `archive_reason: resolved-24h`); returns `{ moved, failed }`
- `archiveStaleOpenHandovers()` — moves open handovers idle more than 30d, measured from the later of `created` and mtime (header gets `archive_reason: stale-30d`; legacy files get an `ARCHIVED-STALE:` line); invalid, unreadable and empty files never move; returns `{ moved, failed }`
- `runHandoverMaintenance(runsRoot, now, { beforeArchive })` — the hook's whole handover sequence: `cleanupHandoverTemps()`, one `scanItems()`, the optional `beforeArchive()` callback (the hook does not pass it), archive resolved then stale-open from that one list, then rescan only if some item was `isArchiveDue` before the archive step. Returns `{ scan, resolved, stale }`, which `.claude/hooks/session-start.js` prints from.
- `cleanupHandoverTemps()` — removes `.hv-tmp.*` files older than 60 min in `plans/` and `plans/_archive/` (orphans from killed writers); skips a symlinked `plans/` or `_archive/`
- `archiveStaleReminders(vault, today, maxAgeDays = 30)` — sets vault reminders due more than 30 days before `today` to archived via `vault.setStatus` (a status change, not a file move). The vault is injected because `lib/vault.js` loads `bun:sqlite` at module top and would throw under node; the hook calls it via `bun -e`
- consumed by `.claude/hooks/session-start.js` (`runHandoverMaintenance`, `pickLastSession`) and `bin/handover-write` (`pickLastSession`)

## worker-backend.js

Backend selection for worker panes (tmux or herdr). The gate is read only at spawn time.

- `isHerdrMode(env)` - true only when `ADVISOR_HERDR` is exactly `'1'` and `HERDR_ENV` is exactly `'1'`
- `readRunnerBackend(runDir)` - reads the `runs/<sid>/backend` marker first, then `runner.json` `backend`; returns `'herdr'` or else `'tmux'` (also when both are missing or malformed); teardown uses it, observe reads `runner.json` for `pane_id`
- `resolveSocketPath(env)` - `HERDR_SOCKET_PATH`, else throws with code `HERDR_NO_SOCKET`
- `resolveHerdrBin(env)` - the one place the herdr binary is chosen: `HERDR_BIN_PATH`, else `herdr` on PATH
- consumed by `lib/herdr-runner.js`; tests in `tests/worker-backend.test.js`

## herdr-client.js

JSON-lines client for the herdr unix socket (`{id,method,params}` per line, `{id,result|error}` back).

- `createClient({socketPath, timeoutMs})` - request/response client; `timeoutMs` defaults to 10000
- `request()` rejects any method outside its `ALLOWED_METHODS` set with `HerdrError` code `method_not_allowed` before anything is written to the socket; tab, workspace, server and session teardown methods are not in the set
- `HerdrError` - herdr answered with an error; carries `code` (e.g. `pane_not_found`)
- `HerdrUnavailableError` - the socket could not be reached or dropped
- consumed by `lib/herdr-runner.js` and `lib/herdr-panes.js`; tests in `tests/herdr-client.test.js`

## herdr-panes.js

Worker pane placement, tagging and token-checked close in the user's live herdr session. Pane ids are reused across herdr sessions, so a pane is closed only when its `advisor_sid` token matches.

- every call goes through an allow-list (`ALLOWED_METHODS`); any other method, tab, workspace, server and session teardown included, throws `herdr-method-not-allowed`
- `ensureWorkerPane()` - finds or creates the tab labelled `advisor` (`advisor-2`, `advisor-3`, ... once a tab holds `TAB_PANE_CAP` = 6 panes), splits the last pane at ratio 0.5, odd pane count goes right and even goes down; all create and split calls pass `focus:false`; a lock directory serialises concurrent summons
- `allocateEnsemblePanes()` - one tab `ensemble-<N>-<YYYYMMDD>` with N panes
- `tagPane()` - sets and reads back the `advisor_sid` token (cut to 80 chars); called only by `ensureWorkerPane()` / `allocateEnsemblePanes()` inside the lock, right after each create or split; each allocation reports `tagged` (and `tagError`), and `lib/herdr-runner.js` starts a worker only for a tagged pane and never re-tags
- `closePaneChecked()`, `closeWorkerBySid()`, `closeSelf()` - close a pane only on a matching token; `reapOrphanHerdrPanes()` sweeps tagged orphans on every herdr summon (run's `session.json` unchanged for 24 h, sid timestamp at least 2 h old, no process mentions the sid; token-checked close); `probeRunnerPane()` reports pane state for observe
- no equalise step: panes end up unequal in size
- consumed by `lib/herdr-runner.js`; tests in `tests/herdr-panes.test.js`

## herdr-runner.js

Per-worker supervising process for the herdr backend. Sets `ADVISOR_NO_REAPER=1` before loading `lib/tmux-runner.js` (reuses its sentinel, hook and `runner.json` helpers).

- launches the worker in its pane with `ADVISOR_WORKER_BACKEND=herdr` and `HERDR_STRIP_ENV` removed via `exec env -u`
- readiness and prompt submission are handled here using herdr's agent state
- supervises until the outbox result, pane exit, subscriber outage or hard timeout; a worker that exits with no result gets a synthetic result line with `reason=pane-died`, or `reason=herdr-restart` when the herdr server was lost
- CLI modes: `--launch-from-meta` (called by `bin/summon`), `--run`, `--close --sid`, `--close-self`, `--pane-state --sid`
- consumed by the herdr branches of `bin/summon`, `bin/close-tab`, `bin/close-worker-tab` and `bin/advisor-observe`; tests in `tests/herdr-runner.test.js`
