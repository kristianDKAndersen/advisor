# mods/

Claude Code "mods" are plugins that hook into Claude Code's own events
(`tool.call`, `session.start`, etc.) to change or observe its behavior. Each
subdirectory here is one mod.

## Running a mod

```bash
claude --plugin-dir mods/write-gate
```

Loads the mod for one interactive session. Repeat the flag to load several
mods at once. The hooks module reloads automatically on save.

## Testing a mod

```bash
claude plugin validate --strict mods/write-gate   # manifest + hooks sanity check
claude plugin test mods/write-gate                # runs *.test.ts under the mod dir
```

`claude plugin test` is a separate test runner from the repo's own `bun test`
suite (see `bunfig.toml`, `root = "tests"`) — a mod's `*.test.ts` files live
under `mods/<name>/tests/` and are not collected by `bun test`.

## Mods in this directory

### write-gate

Denies any `Write` tool call whose content exceeds a configured byte limit.

**Default limit:** 51200 bytes.

**Configuration:** Write-gate exposes a `maxWriteBytes` user option (default 51200,
range 1024..10 MiB). Configure it via:
```bash
echo '{"maxWriteBytes": "10240"}' | claude plugin configure write-gate --values-stdin
```
Invalid or out-of-range values (not a finite integer, `< 1024`, or `> 10485760`)
fall back to the default and log a debug explanation.

Note: configuration via `--values-stdin` is not yet verified for mods loaded
with `--plugin-dir` inside the Advisor environment.

**Limits:** None beyond the byte range. All `Write` calls are intercepted;
exceeding the limit produces a denial reason in the UI.

### canary

Dead-man's switch: writes a per-session heartbeat to `$.store` (key `hb:<sessionId>`,
refreshed every 30s, `endedAt` set on `session.end`) so a stale heartbeat is
visible to external tooling when the hooks worker dies outright. Also shows one
toast per mod per session if that mod's `plugin.register` count hits 3, ahead of
the 3-crash rule that disables every mod.

**Limits:** Heartbeat writes are local only; no network calls.

### fleet-waker

Inside the Advisor's own session (inert inside a worker session), watches
`bin/summon` calls for their `{sid, agent, outbox}` by scanning tool logs and
the runs-root directory. Polls each watched outbox every 5s for a terminal
(`result`/`error`) or `question` message at least 30s old and not already
recorded in that run's `synthesis.log`, then starts a new Advisor turn via
`$.prompt.submit` batching every worker that finished that tick - a true
fallback alongside `bin/advisor-observe`, never double-waking.

**Poll optimization:** Each tick does a cheap `fs.stat` first and only re-reads
an outbox when its size or mtime changed (falling back to a read if the stat
itself fails). A grace-pending result or error is still re-checked every tick
from the watch's own in-memory record, so it wakes on schedule even when the
file never changes again.

**Live fleet band:** Shows a compact live fleet band above the prompt whenever
at least one worker is being watched: one row per worker (short sid, agent, age,
last event type, and "waiting grace" when a terminal event is pending grace),
capped at 5 rows with a "+N more" summary row, hidden entirely at zero workers.
Never replaces other mods' `AbovePrompt` content — it always renders alongside it.

**Limits:** Polls every 5s per watched worker; grace periods are 30s.
Inert in worker sessions (does not pollinate nested Advisor instances).

## Health

`bin/advisor-mods-health` reads every session's canary heartbeat
(`~/.claude/plugins/store/canary_*.json`) and classifies it OK / ENDED /
STALE / GONE, so mod-layer health is visible from outside Claude Code — no need
to open a session to check whether the hooks worker is still alive.

**Usage:**
```bash
bin/advisor-mods-health              # table, newest first
bin/advisor-mods-health --json       # machine-readable
bin/advisor-mods-health --all        # include ENDED records older than 1h, and GONE records
bin/advisor-mods-health --stale-after 60   # override the 90s default
bin/advisor-mods-health --max-age 3600     # override the 6h STALE->GONE threshold
```

**Status meanings:**
- `OK` — last heartbeat is within `--stale-after` seconds (default 90 = three missed 30s beats).
- `ENDED` — `session.end` ran (heartbeat carries `endedAt` timestamp).
- `STALE` — last heartbeat is older than `--stale-after` (no recent beat means mods unloaded,
  crashed, or session was killed).
- `GONE` — a `STALE` record's last beat passes `--max-age` (default 6h). Hidden unless
  `--all` is passed; never affects exit code.

**Exit codes:**
- `0` — no STALE records (or no canary heartbeats found).
- `3` — at least one STALE record.
- `2` — usage error.

## Smoke test

`bin/advisor-mods-smoke` live-tests write-gate, canary, and fleet-waker in throwaway
Claude Code sessions. Prints PASS/FAIL per check in one command.

**Usage:**
```bash
bin/advisor-mods-smoke                              # all three checks
bin/advisor-mods-smoke --only write-gate            # single check (repeatable)
bin/advisor-mods-smoke --only canary --only fleet-waker
bin/advisor-mods-smoke --model sonnet               # override model (default: haiku)
bin/advisor-mods-smoke --keep                       # preserve temp dirs; print paths
bin/advisor-mods-smoke --json                       # machine-readable output
bin/advisor-mods-smoke --timeout-scale 2            # multiply all poll timeouts by N
```

**Exit codes:**
- `0` — all checks passed.
- `1` — at least one check failed.
- `2` — usage error.
- `4` — missing prerequisite (`claude` or `tmux` not on PATH).

**What each check proves:**
- **write-gate:** Verifies that `Write` calls under the limit pass and over the limit are denied,
  in a live throwaway session.
- **canary:** Checks that heartbeats are written and refreshed, and that `session.end` sets
  the `endedAt` timestamp.
- **fleet-waker:** Confirms that fleet-waker detects summoned workers, polls their outboxes,
  and wakes the Advisor when a worker finishes (via mocked `summon` calls and a fake outbox).

**Runtime:** ~6 minutes. Uses haiku by default (configurable with `--model`). **Cost note:**
one haiku session per check × ~2 min per session ≈ 6-8 haiku-minutes total.

Note: `bin/advisor-mods-smoke` must never be run from within a nested Claude Code session
(per scope boundary in worker briefs); it is intended for the Advisor's own uptime checks
and CI/CD pipelines.

## Enabling / disabling

Nothing here is enabled for real sessions by default. To try a mod across all
your sessions, add its absolute path to `CLAUDE_CODE_PLUGIN_DIRS` (colon- or
semicolon-separated) in your own `~/.claude/settings.json` `env` block, or
pass `--plugin-dir` per invocation as above.

**Important:** Mods run with the user's full OS permissions and are not sandboxed even when Bash sandboxing is on. They can read/write files, spawn processes, use the network, read env vars/secrets, see and change prompts and tool calls, and approve tool calls without asking. Installed mods share one hooks worker thread; if it crashes 3 times in a session, Claude Code unloads every non-built-in mod for the rest of that session until `/reload-plugins`. Load only mods you trust.

Disable all mods with `disableAllHooks` in a settings file.
