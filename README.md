# Advisor

A strong-model orchestrator for multi-agent task decomposition. Advisor receives a user prompt, decomposes it into scoped worker briefs, summons workers via `bin/summon`, and synthesizes their results into a coherent response. Advisor does not execute work it can delegate.

For the full orchestration protocol, see `CLAUDE.md`.

## How it works

```
User prompt
    │
    ▼
1. Decompose → write briefs   (/brief validates 5 required fields)
    │
    ▼
2. bin/summon --agent <name> --task "..." --goal "..."  [--model <id>] [--intelligence <score>] [--ensemble N] [--allowed-tools <list>]
   └─ opens Terminal tab, seeds inbox, exports $INBOX/$OUTBOX/$OUTPUT_DIR/$ADV/$REPO
      coder agent: provisions git worktree branch ws/<sid> instead of a copyDir workspace
    │
    ▼
3. Observe outbox  (tail / recv)
   └─ on `result`: SYNTHESIS REQUIRED block → run /synth before anything else
    │
    ▼
4. Synthesize → close worker tab → report or spawn refinement worker
```

Workers run in isolated, ephemeral workspaces. Durable output lands in `$OUTPUT_DIR` (`~/.advisor/runs/<sid>/output/` for self-invocations, `<repo>/.advisor-output/<sid>/` otherwise).

## Repo layout

```
bin/
  _worktree-capture.sh  # capture-before-remove helper — snapshots a coder worktree's changed+untracked files into $OUTPUT_DIR before removal (sourced, internal)
  advisor-cost        # per-session cost report — reads ~/.advisor/state/token-usage.jsonl and prints token counts + estimated cost by session; --by-agent aggregates by agent name (requires session-map.jsonl)
  advisor-cost-backfill  # backfill token-usage.jsonl rows for worker sessions whose Stop hook never fired and whose synthesize-time accrual predates or missed the fix (--dry-run)
  advisor-list        # list all sessions under ~/.advisor/runs/ (--json, --repo, --agent)
  advisor-observe     # tail a session's outbox; emits JSON per message; exits on result/error/timeout (--after, --max-wait, --poll)
  advisor-schedule    # launch autonomous loops detached in a tmux window (--sid, --interval, --task, --once)
  advisor-timeline    # HTTP timeline dashboard on port 7878 — SSE live updates, color-coded by message type
  advisor-vault       # query the native vault index (search / backlinks / path / due [--within <days>])
  advisor-vault-mcp   # JSON-RPC 2.0 MCP stdio server exposing the vault to Claude Desktop and claude-code (internal)
  brief               # validate 5-field brief and emit bin/summon command (auto-populates --allowed-tools)
  capture             # noisy-command output filter — pipes stdout/stderr through a scored summary, saves full raw log to $OUTPUT_DIR/captures/<id>.log; preserves exit code for TDD evidence
  browser-act         # execute one browser action via the daemon UNIX socket (internal)
  browser-launch      # start Chrome and browser daemon, print session JSON (internal)
  browser-state       # read current browser DOM state from the daemon (internal)
  browser-stop        # stop browser daemon and Chrome for a session (internal)
  close-tab           # close current macOS Terminal tab (called by workers on self-terminate); in ADVISOR_TMUX_MULTIPLEX=1 mode, kills only $TMUX_PANE (never falls back to the attached client's active pane, which could kill an unrelated live worker)
  close-worker-tab    # close a specific worker's tab by SID (called by Advisor post-result)
  advisor-terminate   # atomic terminate + close-worker-tab in one call
  handover-resolve    # resolve a context-handover file by appending "FINAL OUTCOME: <text>" (run from the successor session, not at handover-write time)
  run-pipeline        # pipeline orchestrator (internal)
  summon              # provision + open a worker session in a new Terminal tab; flags: --agent, --task, --goal, --model, --intelligence, --ensemble, --allowed-tools, --sub-team, --sub-team-model, --timeout
  summon-parallel     # fan out multiple briefs to parallel worker sessions (--briefs <path.json>)
  tournament          # parallel TDD tournament orchestrator (--spec, --strategies, --keep-losers, --dry-run)
lib/
  channel.js          # append-only JSONL channel: send / recv / tail / synthesize; acquireSeqLock + withSessionLock (mkdir spinlocks with stale-lock recovery for hard-killed processes); Tail class (byte-offset incremental reader)
  compactor.js        # transcript compaction: repairToolUseResultPairing + 4-phase compactMessages pipeline (prune tool_results → boundary trim → summarize → sanitize); PreCompact hook entry point — rewrites the transcript in place via atomic tmp+rename
  episodes.js         # episodic memory: writeEpisode / queryEpisodes over ~/.advisor/memory/episodes.jsonl, keyed by task_hash
  graphify-setup.sh   # one-time graphify pre-index helper — builds the code graph (graphify update . --no-cluster) and installs graphify's auto-rebuild hook
  session.js          # session plumbing: IDs, workspaces, session.json, output-dir logic
  summon.js           # Bun core: provisions workspace, composes bootstrap prompt, writes launch.sh; --intelligence flag (resolves tier→model via adapter/intelligence-map.json); --ensemble N (parallel workers + batch envelope); --allowed-tools (camelCase internally); --sub-team injects the delegator/teammate skill
  tmux-runner.js      # detached background-loop runner used by bin/advisor-schedule; module-load reapers (orphan tmux sessions + stale coder worktrees; opt out with ADVISOR_NO_REAPER=1)
  tool-guard.js       # PreToolUse hook: blocks writes to spec-authored protected test paths (ADVISOR_PROTECTED_TESTS) + live circuit breaker — halts a worker on the 3rd identical tool call
  vault.js            # native vault writer + FTS5 search (synthesis notes, session notes, lessons)
  hooks/              # PostToolUse worker hooks (worker-trace.js, worker-inbox-poll.sh, worker-auto-close.sh) — opt-in via ADVISOR_WORKER_HOOKS; branch-guard.js (coder-only PreToolUse)
adapter/
  intelligence-map.json  # 7-band tier→model+reasoning manifest used by --intelligence flag (haiku-4-5 → sonnet-4-6 → opus-4-8 → fable-5 at [95,100])
spawns/
  brainstormer/       # (each contains CLAUDE.md that defines the worker's role)
  browser/
  code-reviewer/
  coder/
  creative/
  deep-researcher/
  diff-walker/
  doc-agent/
  evaluator/
  fact-checker/
  frontend/
  migration/
  philpsych/
  planner/
  researcher/
  spec/
  tournament-evaluator/
  vault-curator/
skills/
  advisor-doctor/           # /advisor-doctor — one-shot diagnosis of a stalled advisor session
  ai-interaction-principles/ # /ai-interaction-principles — 39 human-AI interaction design principles checklist for user-facing AI features
  brief/                    # /brief — validates fields and emits bin/summon command (--allowed-tools)
  extract-lesson/           # /extract-lesson — post-mortem analyst; writes negative-polarity lesson notes
  sub-teams/                # /sub-teams — orchestrates a delegator + N teammates via the Task tool
  synth/                    # /synth — validates fields and runs channel.js synthesize
  tournament/               # /tournament — parallel TDD tournament orchestrator
  vault-due/                # /vault-due — act on the SessionStart vault-due banner (done / snooze / archive)
  worker-protocol/          # /worker-protocol — inbox polling, tracing, self-terminate rules
.claude/
  settings.json       # Advisor harness config (permissions, hooks, env vars)
  hooks/              # SessionStart banner (vault-due next 14d + last handover), PostToolUse session.json updater, statusline
  skills/
    context-timeline/ # /context-timeline — triggers bin/advisor-timeline for the current session
    observe/          # /observe — live session observation mode
    pre-compact/      # /pre-compact — manual pre-compaction checkpoint
~/.advisor/runs/<sid>/
  channel/inbox.jsonl   # Advisor → worker
  channel/outbox.jsonl  # worker → Advisor
  workspace/            # ephemeral copy of spawns/<name>/ — the worker's cwd (coder agent: git worktree at branch ws/<sid>)
  output/               # durable deliverables (self-invocation) or <repo>/.advisor-output/<sid>/
  meta.json             # session metadata (sid, agent, task, goal, outputDir, repo, …)
  session.json          # tier, decomposition status, next_action (recovery checkpoint)
  synthesis.log         # JSONL log of all synthesis records for this session
  bootstrap-prompt.txt  # prompt passed to the worker's claude invocation
  launch.sh             # shell entry point opened by osascript
  tty.txt               # worker's tty path (used by close-worker-tab)
  tool-counts.json      # per-session duplicate tool-call counts (tool-guard circuit breaker)
~/.advisor/vault/
  synthesis/<sid>-<seq>.md  # one note per synthesize call (auto-written)
  sessions/<sid>.md         # one note per session (auto-written by lib/session.js)
  lessons/<sid>-<agent>-<seq>.md  # negative-polarity lesson notes (written by /extract-lesson)
  .cache/index.sqlite       # FTS5 BM25 index over all notes
~/.advisor/memory/
  episodes.jsonl            # episodic memory — one record per synthesize call (queried by bin/summon)
```

## Quick start

1. Open this repo in Claude Code. The `.claude/settings.json` activates the Advisor harness and prints an agent banner on session start.
2. Describe your task. Advisor classifies it, decomposes it, and summons workers automatically.
3. Each worker opens in a new macOS Terminal tab and reports back via the JSONL channel.
4. When a worker delivers `result`, the SYNTHESIS REQUIRED block appears. Run `/synth` with the four fields filled in. (`bin/close-worker-tab <sid>` is auto-called by synthesize; manual fallback only.)

## Agents catalog

| Agent | Role |
|-------|------|
| `code-reviewer` | Reviews code for defects on multiple quality dimensions; produces `review.md`; never writes code |
| `coder` | Implements fixes from a structured spec; edits files in `$REPO` in place; produces `changes.md`; default workflow is red-green-refactor with pasted command output as evidence (red + green) |
| `creative` | Runs the `creative-thinking` skill, which orchestrates mapper → 3 of 5 cognitive-persona subagents in parallel → synthesizer via the Task tool; auto-routes to Solo Mode for trivially scoped problems |
| `deep-researcher` | Heavyweight three-phase investigation (Discovery → Bias Audit → Synthesis); fans out to `bias-auditor` + `report-architect` subagents via Task tool; produces a structured, bias-audited report |
| `diff-walker` | Cascade-tests a CLAUDE.md prompt edit against a corpus of real tasks on 4 axes; produces `cascade-report.md` |
| `evaluator` | Scores a worker result on 5 rubric dimensions (factual accuracy, citation precision, completeness, source quality, tool efficiency); produces `scores.json` |
| `frontend` | Builds self-contained frontend deliverables (landing pages, components, static sites); verifies in browser before reporting |
| `philpsych` | Writes the character / behavioral section of an agent's system prompt using psychology frameworks (SDT, Big Five, CBT, Stoicism) |
| `planner` | Decomposes a task into a wave-parallelized plan (files_modified mutex, stable U-IDs, claim-to-evidence DoD, multi-source coverage audit, banned-phrase list, status enum); produces `plan.md`; mandates a failing-test subtask in the earliest wave for every behavior change (Test-first ordering) |
| `researcher` | Executes research tasks (library evaluation, trend scan, fact-finding); cites every non-trivial claim; produces structured reports |
| `browser` | Browser automation agent; drives Chrome via the `browser-*` binary suite for web interaction tasks |
| `fact-checker` | Spot-checks external-tool pricing, licensing, version, and availability claims against authoritative sources; auto-invoked after synthesis when result body contains dollar amounts, 'free/paid', license names, or version-to-feature assertions |
| `spec` | Drafts implementation specs from a goal — produces an executable spec the `coder` agent can implement; used as the upstream stage of `/tournament` |
| `tournament-evaluator` | Scores and ranks competing coder implementations against a shared test suite; used by the `/tournament` skill |
| `migration` | Migrates a source codebase to a target architecture; reads `source_repo` and an `arch_def` (prose, YAML, Confluence export, or Miro export) and produces migration changes in the target tree |
| `vault-curator` | Curates vault notes by deduplication — walks notes matching `scope_glob`, flags or merges pairs whose similarity exceeds `similarity_threshold`, and produces a curation report |
| `brainstormer` | Facilitates structured product ideation sessions using a 6-stage stage-gated model (Frame → Discover → Focus → Generate → Decide → Validate) that prevents premature convergence through enforced phase separation, technique rotation, and an explicit idea ledger; produces `ideas.md` + `session.md` |
| `doc-agent` | Batch-processes unprocessed entries from `~/.advisor/doc-queue.jsonl` and updates the nearest `AGENTS.md` for each affected directory in the repo; skips when queue is empty |

### Advisor-side skills (`.claude/skills/`)

Not to be confused with worker-facing `skills/` above — these are invoked directly in the Advisor's own session: `/observe` (canonical outbox-watching pattern), `/pre-compact` (pre-flight checklist before manual `/compact`), `/context-timeline` (launches `bin/advisor-timeline` for the current session).

## Creative Council Mode

The `creative` agent runs the council internally via the **`creative-thinking` skill** (agent-scoped at `spawns/creative/.claude/skills/creative-thinking/`). The advisor's only job is to `bin/summon --agent creative` once — no advisor-side persona orchestration.

Pipeline (run inside the creative agent via the Task tool, enabled by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `spawns/creative/.claude/settings.json`):

```
mapper  →  forbidden-ideas.md + assumptions.md + persona-plan.md
     ↓
3 of 5 personas in parallel (each reads forbidden-ideas.md as hard exclusions)
    naturalist · systematist · futurist · oracle · constraintist
     ↓ 3 idea files
synthesizer (External Forger — sees only the 3 persona idea files, not the briefs)
     ↓
council-result.md
```

**Escape hatch — Solo Mode:** The skill auto-routes to Solo Mode (no subagents, no fan-out) when the prompt is ≤ 15 words with no domain anchor, or contains "quick check" / "evaluate an idea" / "don't overthink" phrasing. Council is the default behavior for all other prompts; the "opt-in" framing no longer applies.

## Test-driven development (default)

The planner and coder agents use red-green-refactor as their default workflow. No brief annotation is required to activate it.

**Planner:** inserts a failing-test subtask in Wave 0 (or the earliest applicable wave) before every behavior-changing implementation subtask. The implementation subtask's DoD references the test transitioning from failing to passing.

**Coder:** per-fix loop is Red (write or locate failing test, run it, capture failing output) then Green (implement minimum change, re-run, capture passing output) then Verify (syntax check or broader suite). Both runs must be pasted verbatim with the exact command and exit code in `changes.md`. A claim like "test passes" without pasted output is a protocol violation.

**Exemptions:** pure refactors, doc edits, and spikes can be marked `TDD-waived` with a one-line justification. The worker self-documents these in `changes.md`.

**Verdict semantics:** the result envelope downgrades from `complete` to `partial` when any non-waived fix lacks paired red+green evidence. A `partial` verdict on a docs-only or refactor task usually means the worker marked fixes as TDD-waived — read `changes.md` before treating `partial` as a failure.

## Skills catalog

Skills are installed to `~/.claude/skills/` by `bin/summon` and invoked with a slash command. The `creative-thinking` skill is **agent-scoped** — it lives at `spawns/creative/.claude/skills/creative-thinking/`, not in the top-level `skills/` directory, and is only available within the `creative` agent's session.

| Skill | Purpose |
|-------|---------|
| `/brief` | Validates 5 required fields (objective, output, tools, scope, parallelism) then emits a `bin/summon` command with the task string assembled from all 5 fields; does not set `--allowed-tools` or `--intelligence` (those flags are only available via `bin/brief` directly) |
| `/synth` | Validates 4 required fields (sid, seq, established, gap) then invokes `channel.js synthesize` |
| `/extract-lesson` | Post-mortem analyst — turns a `verdict=blocked, material=yes` synthesis into a negative-polarity lesson note in the vault; auto-triggered on the 2nd evaluator failure for the same task shape |
| `/worker-protocol` | Loads inbox-polling rules, tracing cadence, and self-terminate behavior into a worker session |
| `/creative-thinking` | **Agent-scoped** (creative agent only) — orchestrates mapper → 3 of 5 cognitive-persona subagents in parallel → synthesizer via the Task tool; returns `council-result.md`; auto-routes to Solo Mode for trivially scoped prompts |
| `/sub-teams` | Runs a sub-team inside a single worker — delegator agent spawns N teammates via the Task tool; opt in with `bin/summon --sub-team` and (optionally) `--sub-team-model <sonnet\|haiku\|opus>` |
| `/tournament` | Runs a parallel TDD tournament — summons N coder workers each with a different strategy, evaluates all against a shared test suite via `tournament-evaluator`, and applies the winning implementation; uses `bin/tournament` |
| `/advisor-doctor` | One-shot diagnosis of a stalled advisor session — inspects `session.json`, the recent outbox tail, tmux panes, processes, and sentinel files |
| `/vault-due` | Acts on the SessionStart vault-due banner — subcommands `done <note>`, `snooze <note> <days>`, `archive <note>` |
| `/ai-interaction-principles` | 39 human-AI interaction design principles checklist (Bakusevych/UX Collective 2026) for briefing or reviewing user-facing AI features — chatbots, agent products, AI-assisted workflows |

## Channel protocol

Each session has two append-only JSONL files: `inbox.jsonl` (Advisor → worker) and `outbox.jsonl` (worker → Advisor).

**Message types:**

| Direction | Type | Meaning |
|-----------|------|---------|
| Advisor → worker | `task` | Initial work assignment (seq 1) |
| Advisor → worker | `guidance` | Mid-task course correction |
| Advisor → worker | `terminate` | Abort; worker closes its Terminal tab |
| Worker → Advisor | `progress` | Intermediate status update |
| Worker → Advisor | `result` | Completed deliverable |
| Worker → Advisor | `question` | Blocked; needs clarification |

**SYNTHESIS REQUIRED block:** When `recv` or `tail` returns an unsynth'd `result`, `channel.js` prints a pre-filled `synthesize` command. Fill the four fields and run it (or use `/synth`) before any other action. Synthesis is logged to `synthesis.log`.

```bash
bun lib/channel.js synthesize \
  --sid <sid> --seq <seq> \
  --established '<what the findings establish>' \
  --gap '<remaining question or "none">' \
  --material <yes|no|partial> \
  --next '<proceed-to-step-8 | spawn-refinement: <gap> | spawn-evaluator>' \
  --key-quotes '<1-2 verbatim quotes; empty string if none>'
```

**Result envelope:** Workers send structured `result` bodies:
```json
{ "summary": "<≤200 char outcome>", "paths": ["<absolute path>"], "verdict": "complete|partial|blocked" }
```

## Session state

Each session writes `~/.advisor/runs/<sid>/session.json` — the recovery checkpoint after context compression:

```json
{
  "schema_version": 1,
  "sid": "<session-id>",
  "user_prompt": "<original user prompt>",
  "tier": "fact | comparison | deep_research | fixated | \"\"",
  "decomposition": [
    { "role": "<worker role>", "scope": "<scope>", "status": "pending | in_progress | complete | blocked", "synthesis_seq": null }
  ],
  "decisions": [],
  "next_action": "<next action directive>"
}
```

Read with `readSessionState(sid)` · Update with `updateSessionState(sid, patchFn)` — both from `lib/session.js`.

`session.json` is written twice: an initial `status:'in-flight'` stub at provision time (`bin/summon`), then updated per synthesize call. This closes a race where a session younger than the orphan-reaper's grace floor (below) had no `session.json` yet.

## Token-economy bootstrap injection

`lib/summon.js` injects a token-frugality block into every worker's bootstrap prompt via `lib/eco-rules.js` — ECO-CORE for most agents, ECO-REVIEW (a completeness-preserving variant) for exhaustiveness-critical agents (`code-reviewer`, `evaluator`, `tournament-evaluator`, `fact-checker`, per the `ECO_REVIEW_AGENTS` set in `lib/eco-rules.js`). Disable globally with `ADVISOR_ECO=0`.

## Hooks

Seven hook commands are registered across five lifecycle events in `.claude/settings.json`:

| Hook command | Event | Matcher | What it does |
|---|---|---|---|
| `session-start.js` | `SessionStart` | — | Surfaces a 'vault due (next 14d)' banner (all note types, not just reminders) and the last context-handover file via `spawnSync`. |
| `workspace-guard.js` | `PreToolUse` | `Edit\|Write` | Rejects edits that would write outside the session's designated workspace; prevents accidental clobbering of other sessions' output. |
| inline `session.json` updater | `PostToolUse` | `Bash` | Detects `channel.js synthesize` calls by inspecting `CLAUDE_TOOL_INPUT`; extracts `--next` directive and patches `next_action` in `session.json` atomically. |
| `test-on-edit.js` | `PostToolUse` | `Edit` | Runs the project test suite after any file edit; surfaces test failures inline so the worker sees red/green in the same turn as the edit. |
| `stop-telemetry.js` | `Stop` | — | Reads `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, sums all four token fields, and appends a record to `~/.advisor/state/token-usage.jsonl` for cross-session cost tracking. Fires reliably for the Advisor's own session but **not** inside worker sessions, which self-terminate via `close-tab` before their turn ends and never emit `Stop`. `bun lib/channel.js synthesize` now accrues telemetry for the worker directly (`lib/telemetry-backfill.js`) as the primary path for worker token counts. |
| `git add -A && git commit …` | `PreCompact` | — | `git add -A && git commit --no-verify -m "auto-save: pre-compaction checkpoint"` — preserves session state across context resets. Note GH#13572: does not fire on manual `/compact`; the Stop hook covers that path. |

**Transcript compaction (`lib/compactor.js`):** a standalone PreCompact hook entry point. Invoked directly, it reads `{transcript_path}` from stdin, repairs orphaned `tool_use`/`tool_result` pairing (`repairToolUseResultPairing`), runs the 4-phase `compactMessages` pipeline — prune tool_results → trim to a user-turn boundary within the token budget → summarize → sanitize — and rewrites the transcript in place via atomic tmp+rename. The PreCompact hook registered in `.claude/settings.json` is the git checkpoint above; `compactor.js` is also importable (`compactMessages`, `repairToolUseResultPairing`, `summarizeInStages`) for programmatic compaction.

**Worker hooks (default-on, injected at provision time):** Five hooks in `lib/hooks/` are injected into every worker's ephemeral workspace `.claude/settings.json` by `lib/summon.js` (`injectWorkerHooks`) — they are **not** stored statically in `spawns/*/.claude/settings.json`. The five hooks: `worker-trace.js` (`PostToolUse`), `worker-inbox-poll.sh` (`PostToolUse`), `worker-auto-close.sh` (`PostToolUse`, `Bash`-only), `worker-session-map.sh` (`SessionStart`), and `worker-result-check.js` (`Stop`). `ADVISOR_WORKER_HOOKS=1` is also set in the worker env by the same code path so the `/worker-protocol` skill's manual trace step is automatically skipped. The hooks automate trace/recv/close-tab boilerplate; `/worker-protocol` remains the fallback if hooks are absent.

**Coder-only PreToolUse hook:** `branch-guard.js` in `lib/hooks/` blocks `Edit` and `Write` calls when the coder worktree is on the wrong branch. It derives the expected branch `ws/<sid>` from the `INBOX` environment variable (by parsing `/runs/<sid>/channel`), and resolves the workspace via `CLAUDE_PROJECT_DIR` or `process.cwd()`. Fails open on every ambiguous case (non-`Edit`/`Write` tool, `INBOX` unset, workspace not a git repo, detached HEAD); blocks (exit 2) only when git returns a non-empty branch that differs from `ws/<sid>`.

## Tool guard — protected tests and loop circuit breaker

`lib/tool-guard.js` is a PreToolUse hook (exit 2 = block) with two jobs:

- **Protected test paths.** When a brief ships spec-authored tests, `lib/summon.js` exports `ADVISOR_PROTECTED_TESTS` (a JSON path list) into the worker env. The hook blocks `Edit`/`Write`/`NotebookEdit` to any listed path, and heuristically blocks Bash commands that write to one (`>`/`>>` redirects, `tee`, `sed -i`, `cp`/`mv` destinations, `dd of=`, `perl -i`, scripted `vim`/`ed`, inline `python -c`). The Bash detection raises the bar against test tampering — it is not a hermetic seal. A worker that cannot make protected tests pass must send `verdict=blocked` naming the unsatisfiable assertion, not modify the tests.
- **Live circuit breaker.** Every tool call is canonically hashed (SHA-256 over the tool name plus key-sorted arguments). Counts persist across hook subprocess invocations in `~/.advisor/runs/<sid>/tool-counts.json`, guarded by a POSIX-atomic mkdir lock with stale-lock recovery (locks older than 10s are reclaimed). On the 3rd identical call, the hook halts the worker with a loop-detected message — catching workers stuck retrying the same failing action verbatim.

Both gates fail open: no `ADVISOR_SID` disables dedup, no `ADVISOR_PROTECTED_TESTS` disables the path gate, and any lock error or timeout lets the call through rather than wedging the worker.

## Iteration and spawn-fresh model

Workers self-terminate after delivering `result`. There is no in-session refinement. Every follow-up — including same-artifact tweaks — spawns a fresh worker:

```bash
bin/summon --agent <name> \
  --task "<refinement — existing file at outputDir>" \
  --goal "<done condition>"
```

Pass the previous `outputDir` in the task so the new worker can read and update the existing deliverable.

## Watching workers live (tmux multiplexing)

Set `ADVISOR_TMUX_MULTIPLEX=1` (e.g. add `export ADVISOR_TMUX_MULTIPLEX=1` to `~/.zshrc`) to enable the hybrid single-session model. When unset (default), each worker runs in an isolated detached tmux session named `advisor-<sid>`.

When enabled, all workers share one tmux session named `advisor`. Three layouts:

| Invocation | Layout | Window or pane |
|-----------|--------|---------------|
| `bin/summon` (headless, no extra flags) | Solo window per worker | `<agent>-<sid>` window in `advisor` |
| `bin/summon --ensemble N` | N tiled panes in one dedicated window | `ensemble-<N>-<YYYYMMDD>` window |
| `bin/summon --tui` | Shared `tui` window; each task adds a tiled pane | `tui` window (multi-pane) |

**`--ensemble N`** spawns N workers on the same brief, each in its own tiled pane inside one window. All N run independently on the identical task.

**`--tui`** adds each worker as a new tiled pane in the shared `tui` window. On macOS, the first `--tui` call auto-opens a Terminal tab attached to `advisor:tui`; later `--tui` calls add panes to the same already-open window. On non-macOS (or when a client is already attached), summon prints the attach command instead:

```bash
tmux attach -t advisor \; select-window -t tui
```

**Key distinction:** `--ensemble` = N copies of one brief tiled together in a dedicated window; `--tui` = independent tasks from separate `bin/summon` calls tiled together in the shared `tui` window. Solo workers (neither flag) get their own named window — switch between them with window navigation commands.

### Attach and navigate

```bash
tmux attach -t advisor                        # attach to the shared session
tmux attach -t advisor \; select-window -t tui  # attach directly to the tui window
Ctrl-b n                                      # next window
Ctrl-b p                                      # previous window
Ctrl-b w                                      # interactive window picker
```

### Cleanup

Workers self-terminate on completion. `bin/close-worker-tab <sid>` (called automatically by synthesize) kills the worker's pane (located via the `@advisor_sid` pane tag) or window; the window collapses when its last pane exits. A reaper sweeps stale orphan windows and sessions (>24h, no live process) at module load, intentionally skipping `ensemble-*` and `tui` windows whose lifecycle is managed separately. A second reaper (`reaperSweepOrphanSessions`) kills orphaned `advisor-*` tmux sessions whose `session.json` is missing/stale (>24h) and has no live process — but never touches a session younger than 2h, since `session.json` may not exist yet for a session still mid-provision. A third module-load reaper captures-then-removes leaked coder worktrees (see Worktree durability below); all reapers are disabled by `ADVISOR_NO_REAPER=1`.

## Worktree durability

Coder workspaces are real git worktrees (branch `ws/<sid>`), so uncommitted coder output must survive teardown. Three guarantees:

- **Capture-before-remove.** Before any coder worktree is force-removed, `bin/_worktree-capture.sh` snapshots its changed + untracked files into `$OUTPUT_DIR/worktree-capture/`. Fail-closed: if capture fails, a `CAPTURE_FAILED` marker is written and removal is skipped — un-captured work is never destroyed (operator escape hatch: `ADVISOR_FORCE_REMOVE_UNCAPTURED=1`). Used by both `bin/close-worker-tab` (synthesize-driven teardown) and the orphan reaper. Non-worktree (copyDir) workspaces are a graceful no-op.
- **Reaper race protection.** `reapStaleWorktrees` (`lib/tmux-runner.js`) captures-then-removes leaked `ws/<sid>` worktrees at module load, capped at 25 per sweep so a leaked backlog can never stall import. Mid-provision worktrees are spared: a worktree with no `session.json` is skipped (provisioning may still be in flight), as is any worktree younger than ~1h (grace floor derived from the sid's unix-timestamp prefix). `bin/summon` exports `ADVISOR_NO_REAPER=1` during provisioning so module loads triggered by summon itself never reap; the test harness sets the same flag via `tests/setup-no-reaper.js` (wired in `bunfig.toml`).
- **Sentinel ownership validation.** `pollSentinel` (`lib/tmux-runner.js`) validates that the Stop-hook sentinel's JSON payload actually belongs to the polling worker (matches the expected `ownerDir`/`cwd`); a foreign or mismatched payload is discarded rather than accepted, preventing one worker's Stop hook from falsely completing another's poll.
- **Stale-lock recovery and atomic writes.** The session and seq locks in `lib/channel.js` reclaim locks left behind by hard-killed processes, and `lib/compactor.js` rewrites transcripts via write-temp-then-rename, so a crash mid-operation can neither wedge the channel nor corrupt a transcript.

## Advisor model (per worker)

Each worker can consult a stronger reviewer through the native advisor tool. That tool's model is set by the `advisorModel` setting in `.claude/settings.json` (global default: `opus`) — `claude` has no `--advisor` CLI flag. `bin/summon` tunes the policy per worker by writing the worker's launch environment:

- **Fable workers** (resolved model in the `[95,100]` intelligence band — `claude-fable-5`): get `export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, which hard-disables the advisor for that worker. A Fable main model can only pair with a Fable advisor — the API rejects an opus/sonnet advisor for a Fable request (`cannot be used as an advisor`) — and running a Fable advisor on every Fable worker is expensive overkill.
- **Every other worker**: no per-worker export — inherits the global `advisorModel` (`opus`), the working default.

Implemented in `lib/summon.js`; pinned by `tests/summon-advisor-disable.test.js`.

## Self-healing — lesson vault

The advisor learns from failure across sessions via a Reflexion-style post-mortem channel. When a worker delivers `verdict=blocked` with `material=yes`, `lib/channel.js synthesize --verdict blocked` emits a `LESSON EXTRACTION REQUIRED` block. The `/extract-lesson` skill turns the failure into a negative-polarity lesson note (one heuristic, one trigger, one anti-pattern) and writes it to `~/.advisor/vault/lessons/`.

Before writing a brief, the advisor queries the vault:

```bash
bin/advisor-vault search --text '<3 keywords from task type>'
```

Matching `[lesson]` entries are appended as a `Prior failure constraints:` block at the bottom of the brief, so the new worker inherits the constraint without rediscovering the failure mode.

`bin/summon` also auto-injects the top-3 vault recall hits for the raw task text into every worker's bootstrap prompt (gated by `ADVISOR_VAULT_RECALL=0` to disable), but this manual search remains the recommended path when you need task-type-specific lesson filtering.

**Trigger threshold:** lesson extraction is auto-triggered on the **2nd or subsequent** `overall_pass: false` evaluator verdict for the same task shape in a session — a single failure is treated as task-specific noise. Lessons are always negative-polarity (what to avoid); positive-polarity success notes are not stored.

The vault is backed by an FTS5 SQLite index at `~/.advisor/vault/.cache/index.sqlite` and indexes synthesis records, session notes, and lessons. All three are written automatically — no manual indexing step.

Vault due notes (including lessons due in the next 14 days) are also surfaced automatically by the SessionStart hook at the start of each session. Use `bin/advisor-vault due [--within <days>]` to query due notes at any time.

## Episodic memory

Alongside the lesson vault, the advisor keeps a cross-session episodic log at `~/.advisor/memory/episodes.jsonl` (`lib/episodes.js`). Every `channel.js synthesize` call appends one episode — `{sid, task_hash, ts, established, gap, key_quotes}` — where `task_hash` is the SHA-256 of the session goal (first 200 chars).

When `bin/summon` composes a worker's bootstrap prompt, it hashes the new goal the same way and queries the log for up to 3 matching episodes. Matches are appended to the prompt as a `## Past episodes` section, so a worker assigned a previously seen task shape starts from what earlier sessions established — and which gaps they left — instead of rediscovering it.

## Guardrails summary

- **Brief specificity.** Before summoning, confirm two workers can't end up researching the same thing.
- **Synthesize before moving on.** Run `/synth` on every `result` before spawning a new worker or reporting to the user.
- **Spawn-fresh for follow-up.** Workers self-terminate; every refinement is a new `bin/summon` call.
- **Don't do the worker's job.** Delegate all multi-file edits, docs, tests, and code changes — including edits to this repo's own files.
- **Cascade test for prompt edits.** After editing CLAUDE.md or an agent prompt, run `diff-walker` to check for behavior regressions.

Full guardrails and the complete orchestration protocol are in `CLAUDE.md`.

## Prerequisites

**tmux** — required for headless worker spawning and all multiplexing layouts. Install via your package manager (e.g. `brew install tmux` on macOS).

**graphify (optional)** — powers the graph-class checks in the `code-reviewer` and `migration` agents. Install with `npm install -g @graphify/cli`, then run `bash lib/graphify-setup.sh` once per repo: it builds a keyless code-only index (`graphify update . --no-cluster`, output at `graphify-out/graph.json` + `GRAPH_REPORT.md`) and installs graphify's auto-rebuild hook (`graphify hook install`) so the index stays current. The script exits cleanly when graphify is not installed; without an index, the code-reviewer's graph checks degrade to "flag as possible — recommend running graphify-setup.sh to confirm" rather than failing.

**macOS Terminal.app profile configuration** — required for `bin/close-tab` to work.

Open Terminal.app → Settings → select your default profile → Shell tab → "When the shell exits" → set to **"Close if the shell exited cleanly"** (or "Close the window").

Without this setting, worker tabs linger with "Process completed" after workers finish.

## Tests

```bash
bun test                              # full suite
bash tests/close-tab.test.sh          # close-tab integration only
```

Test files live under `tests/` (renamed from `test/` in audit-fix Wave A).
