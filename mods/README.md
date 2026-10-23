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

### cti-sweep

**What it does.** At most once per local day, an interactive session start runs a background Cyber Threat Intelligence subagent (`cti-sweep:cti-analyst`, model sonnet) that looks for new vulnerabilities, supply-chain attacks, breaches, ransomware and state-actor activity since the last successful run (36h by default, at most 7 days). Sources come from `mods/cti-sweep/sources.json`, read at run time; a missing or invalid file falls back to the agent's own search. A macOS notification is raised once per run, only when a new finding names a product on the watchlist (at any severity) or is critical and exploited in the wild; an already-seen id never alerts again. Watchlist matching is whole-token and case-insensitive on the title and products (`Next.js` matches with its dot, `next` inside `Nextcloud` does not); the default list includes Next.js and React, and you set it with the `watchlist` userConfig option in `/config`. Watchlist matches are listed first, most severe first, then exploited criticals. The text is `CTI: N alert(s) - M on your stack - <top title>`, without the stack clause when M is 0. The agent is told to report one finding per distinct issue or product and to cite only canonical per-item pages; the mod drops source URLs on `api.github.com` or `services.nvd.nist.gov` and paths ending in `.xml`, `.atom`, `/feed` or `/rss`, and a finding left with no source is dropped as invalid.

**Gating.** `session.start` only registers `/cti` and schedules the sweep 15s later via `$.clock.after`; it never waits for it. The sweep is skipped when the session is an advisor worker (cwd under `~/.advisor/runs/<sid>/workspace` or `~/.advisor/slots/`, or `ADVISOR_SID` set), headless (`claude -p`, SDK: `isInteractive` false or no surface), or `CTI_SWEEP_DISABLE=1`. It also runs only when your configured default mode is **auto** (see "Auto mode only" below). The day is claimed in `$.store` (`claim:<YYYY-MM-DD>`: `{status, startedAt, finishedAt, attempts}`); a `running` claim older than 2h is stale and may be re-claimed, a `failed` day retries on a later session start, at most 2 attempts a day. `$.store` has no compare-and-set, so two sessions starting together are serialized by an exclusive `mkdir ~/.advisor/cti/.locks/<date>-a<attempt>` (forced runs use `<date>-f<ms>`).

**Where data lives.** `$.store` keys `claim:<date>`, `digest`, `seen` (finding id -> first-seen ms, pruned after 30 days) and `lastSuccess`; the report of every finding (alerts first) at `~/.advisor/cti/YYYY-MM-DD.md` (the first run of a day writes the file; later runs the same day, such as `/cti run`, are appended under a `---` separator and a `## Run HH:MM` heading, never overwritten); lock directories under `~/.advisor/cti/.locks/`.

**Commands.** `/cti` prints the latest digest (alerts, counts, report path); `/cti run` forces a sweep now (ignores done-for-today, still refuses while a non-stale run is in progress; it runs in any mode, since you are there to answer any prompt); `/cti status` prints today's claim record.

**Disable.** Set `CTI_SWEEP_DISABLE=1` in the environment, or disable the plugin. `CTI_SWEEP_DISABLE=1` also stops the feed watcher and the startup toast (they share the session gate); `CTI_FEEDS_DISABLE=1` stops only the feed watcher.

**Startup toast.** Once per session start, 5s after the gate passes, one toast: `CTI: N alert(s) today - /cti for details` when the latest digest has alerts and `digest.finishedAt` is newer than the store key `digestViewedAt`, with ` - M new feed item(s)` appended when notify-worthy feed items arrived after `feedViewedAt`; with no unread digest but such feed items, `CTI: M new feed item(s) - /cti feed`. Nothing otherwise. `/cti` sets `digestViewedAt`, `/cti feed` sets `feedViewedAt`.

**Feed watcher.** A deterministic poller, code only, no LLM or agent. `mods/cti-sweep/feeds.json` is an array of `{id, name, url, format, intervalMin, notify}`: `format` is `rss`, `atom`, `kev-json` or `ghsa-json`; `notify` is `always`, `watchlist` or `never`. The first poll runs 60s after session start, then a 5-minute timer polls the feeds that are due (last fetch plus `intervalMin`, with 60s slack). An exclusive `mkdir` lock per 5-minute slot (`~/.advisor/cti/.locks/feeds-<slot>`) makes two open sessions poll and toast once. Each feed is fetched with argv-only `curl` (30s, 15MB cap, conditional GET via `-z` and `--etag-compare` once the feed has a baseline; 304 means nothing new) into `~/.advisor/cti/feeds/`; a body over 4 MiB is read through `head -c 4000000` (newest items come first). Failures (non-200/304, timeout, parse error, a 200 that parses to zero items) are only logged and counted, and show in `/cti feed status`. Parsers are pure and dependency-free; all feed text is sanitized, titles are capped at 200 characters, only http(s) links are kept, and only the newest 200 items of a feed are considered.
- **Baseline.** A feed's first successful fetch is silent: every item is marked seen and nothing is shown. Seen keys live per feed in `~/.advisor/cti/feeds-state.json` (newest first, cap 500, with `lastFetched`, `failures`, `lastResult`); the file is written to a temp file and renamed.
- **Showing new items.** Per poll, one batched toast `CTI feeds: N new (M on your stack) - /cti feed` and, only when a new item is notify-worthy (`notify: always`, or `watchlist` and the watchlist matches title or text), one macOS notification `CTI feed: <top title>` or `CTI feed: K new - <top title>` (watchlist matches first). Every new item is appended to `~/.advisor/cti/feed-YYYY-MM-DD.md` (time, feed, title, link, `[WATCHLIST]` / `[KEV]`), and the last 100 are kept in the store key `feedRecent`.
- **Commands.** `/cti feed` lists the last 30 new items, newest first; `/cti feed status` lists each feed's last fetch, last result and failure count; `/cti feed poll` polls every feed now in the background and toasts the outcome. A forced poll takes its own lock (`feeds-f<ms>`, like a forced sweep), so a baseline or scheduled poll in the same 5-minute slot cannot refuse it; it still refuses while this session's own poll is running. Feed slot and forced lock directories older than 2 days are removed at most once a day (store key `lockPrunedAt`) by a poll, matching only `feeds-<slot>` and `feeds-f<ms>` under `~/.advisor/cti/.locks/`; sweep day locks are never touched.
- **Adding a feed.** Append an object to `feeds.json` with a unique lowercase `id` and an `http(s)` URL; invalid entries are dropped silently. A new feed baselines on its first poll, so nothing floods.

**Auto mode only.** The scheduled sweep starts only when `permissions.defaultMode` is `auto` in your merged settings (read with `$.settings.read` when the 15s timer fires, right before the day is claimed; unreadable or missing counts as not-auto). The mod grants the analyst no permission of its own: no allow hook, no `permissionMode`, no settings allow-rules. In auto mode the classifier reviews every WebSearch/WebFetch call, which matters because an unattended agent reads attacker-controlled pages. The live mode is not readable: classic hook events carry `permission_mode`, but the built-in `cc-plugin-sec-default` bypasses them for mods. So a session launched with another `--permission-mode`, or switched out of auto mid-sweep, shows permission prompts for the analyst's web calls. That is safe; deny or approve them. To reset a stuck day, delete the `claim:<date>` key in `~/.claude/plugins/store/cti-sweep_*.json` or wait 2h for the stale-running rule.

**Sweep report stays out of the conversation.** When the sweep agent finishes, the engine queues its final answer into the main session as a `prompt.submit` (origin `peer`, text starting `<agent-message from="<agentId>">`). The main session can run shell commands, so letting it answer text written from attacker-controlled pages would break the containment above. The mod's `prompt.submit` hook therefore drops exactly that message (the agent id `$.agent.spawn` returned, kept in memory and in the store key `ownAgents`, pruned after 24h, so a module reload mid-sweep still matches; also a `task-notification` naming that id) and nothing else: user prompts, other agents and peers pass through unchanged. No model request follows; you see a dim `Prompt dropped by a hook: cti-sweep: sweep result kept out of the conversation - see /cti` line, and the drop text never contains agent output. The sweep itself still completes: read results with `/cti` and the report file `~/.advisor/cti/YYYY-MM-DD.md`.

**Security posture.** The analyst reads attacker-controlled pages, so it is a prompt-injection surface. Its tools are exactly WebSearch and WebFetch (no Bash, file, MCP or Agent tools), and its permission decisions are left entirely to the engine (the auto-mode classifier). The agent returns findings only in its final answer; the mod parses the last ```json fence, validates every field, drops invalid items, strips control/ANSI/bidi characters, caps lengths and keeps only http(s) URLs before persisting or notifying. The `osascript` fallback passes the text as argv, never inside AppleScript source.
