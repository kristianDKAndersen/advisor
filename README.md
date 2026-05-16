# Advisor

A strong-model orchestrator for multi-agent task decomposition. Advisor receives a user prompt, classifies it with a fast triage pre-pass, decomposes it into scoped worker briefs, summons workers via `bin/summon`, and synthesizes their results into a coherent response. Advisor does not execute work it can delegate.

For the full orchestration protocol, see `CLAUDE.md`.

## How it works

```
User prompt
    │
    ▼
1. Triage pre-pass  (sonnet, fast)
   └─ emits: tier, recommended_agents, decomposition_seed, confidence
    │
    ▼
2. Decompose → write briefs   (/brief validates 5 required fields)
    │
    ▼
3. bin/summon --agent <name> --task "..." --goal "..."  [--model <id>] [--intelligence <score>] [--ensemble N] [--allowedTools <list>]
   └─ opens Terminal tab, seeds inbox, exports $INBOX/$OUTBOX/$OUTPUT_DIR/$ADV/$REPO
      coder agent: provisions git worktree branch ws/<sid> instead of a copyDir workspace
    │
    ▼
4. Observe outbox  (tail / recv)
   └─ on `result`: SYNTHESIS REQUIRED block → run /synth before anything else
    │
    ▼
5. Synthesize → close worker tab → report or spawn refinement worker
```

Workers run in isolated, ephemeral workspaces. Durable output lands in `$OUTPUT_DIR` (`~/.advisor/runs/<sid>/output/` for self-invocations, `<repo>/.advisor-output/<sid>/` otherwise).

## Repo layout

```
bin/
  advisor-list        # list all sessions under ~/.advisor/runs/ (--json, --repo, --agent)
  advisor-schedule    # launch autonomous loops detached in a tmux window (--sid, --interval, --task, --once)
  advisor-timeline    # HTTP timeline dashboard on port 7878 — SSE live updates, color-coded by message type
  advisor-vault       # query the native vault index (search / backlinks / path)
  brief               # validate 5-field brief and emit bin/summon command (auto-populates --allowedTools)
  close-tab           # close current macOS Terminal tab (called by workers on self-terminate)
  close-worker-tab    # close a specific worker's tab by SID (called by Advisor post-result)
  summon              # provision + open a worker session in a new Terminal tab
lib/
  channel.js          # append-only JSONL channel: send / recv / tail / synthesize; acquireSeqLock (mkdir spinlock for seq IDs); Tail class (byte-offset incremental reader)
  session.js          # session plumbing: IDs, workspaces, session.json, output-dir logic
  summon.js           # Bun core: provisions workspace, composes bootstrap prompt, writes launch.sh; --intelligence flag (resolves tier→model via adapter/intelligence-map.json); --ensemble N (parallel workers + batch envelope); --allowedTools
  vault.js            # native vault writer + FTS5 search (synthesis notes, session notes, lessons)
adapter/
  intelligence-map.json  # 4-band tier→model+reasoning manifest used by --intelligence flag
agents/
  code-reviewer/      # (each contains CLAUDE.md that defines the worker's role)
  coder/
  creative/
  deep-researcher/
  diff-walker/
  evaluator/
  frontend/
  philpsych/
  planner/
  researcher/
  triage/
skills/
  brief/              # /brief — validates fields and emits bin/summon command (--allowedTools)
  extract-lesson/     # /extract-lesson — post-mortem analyst; writes negative-polarity lesson notes
  synth/              # /synth — validates fields and runs channel.js synthesize
  worker-protocol/    # /worker-protocol — inbox polling, tracing, self-terminate rules
.claude/
  settings.json       # Advisor harness config (permissions, hooks, env vars)
  hooks/              # SessionStart banner, PostToolUse session.json updater, statusline
  skills/
    context-timeline/ # /context-timeline — triggers bin/advisor-timeline for the current session
~/.advisor/runs/<sid>/
  channel/inbox.jsonl   # Advisor → worker
  channel/outbox.jsonl  # worker → Advisor
  workspace/            # ephemeral copy of agents/<name>/ — the worker's cwd (coder agent: git worktree at branch ws/<sid>)
  output/               # durable deliverables (self-invocation) or <repo>/.advisor-output/<sid>/
  meta.json             # session metadata (sid, agent, task, goal, outputDir, repo, …)
  session.json          # tier, decomposition status, next_action (recovery checkpoint)
  synthesis.log         # JSONL log of all synthesis records for this session
  bootstrap-prompt.txt  # prompt passed to the worker's claude invocation
  launch.sh             # shell entry point opened by osascript
  tty.txt               # worker's tty path (used by close-worker-tab)
~/.advisor/vault/
  synthesis/<sid>-<seq>.md  # one note per synthesize call (auto-written)
  sessions/<sid>.md         # one note per session (auto-written by lib/session.js)
  lessons/<sid>-<agent>-<seq>.md  # negative-polarity lesson notes (written by /extract-lesson)
  .cache/index.sqlite       # FTS5 BM25 index over all notes
```

## Quick start

1. Open this repo in Claude Code. The `.claude/settings.json` activates the Advisor harness and prints an agent banner on session start.
2. Describe your task. Advisor classifies it, decomposes it, and summons workers automatically.
3. Each worker opens in a new macOS Terminal tab and reports back via the JSONL channel.
4. When a worker delivers `result`, the SYNTHESIS REQUIRED block appears. Run `/synth` with the four fields filled in, then `bin/close-worker-tab <sid>`.

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
| `triage` | Classifies a user prompt into a tier and emits a JSON decomposition seed; invoked via `--model claude-sonnet-4-6` for compatibility with auto mode |

## Creative Council Mode

The `creative` agent runs the council internally via the **`creative-thinking` skill** (agent-scoped at `agents/creative/.claude/skills/creative-thinking/`). The advisor's only job is to `bin/summon --agent creative` once — no advisor-side persona orchestration.

Pipeline (run inside the creative agent via the Task tool, enabled by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `agents/creative/.claude/settings.json`):

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

Skills are installed to `~/.claude/skills/` by `bin/summon` and invoked with a slash command. The `creative-thinking` skill is **agent-scoped** — it lives at `agents/creative/.claude/skills/creative-thinking/`, not in the top-level `skills/` directory, and is only available within the `creative` agent's session.

| Skill | Purpose |
|-------|---------|
| `/brief` | Validates 5 required fields (objective, output, tools, scope, parallelism) then emits a `bin/summon` command; auto-populates `--allowedTools` from the brief's tools field and accepts `--intelligence` to resolve model via `adapter/intelligence-map.json` |
| `/synth` | Validates 4 required fields (sid, seq, established, gap) then invokes `channel.js synthesize` |
| `/extract-lesson` | Post-mortem analyst — turns a `verdict=blocked, material=yes` synthesis into a negative-polarity lesson note in the vault; auto-triggered on the 2nd evaluator failure for the same task shape |
| `/worker-protocol` | Loads inbox-polling rules, tracing cadence, and self-terminate behavior into a worker session |
| `/creative-thinking` | **Agent-scoped** (creative agent only) — orchestrates mapper → 3 of 5 cognitive-persona subagents in parallel → synthesizer via the Task tool; returns `council-result.md`; auto-routes to Solo Mode for trivially scoped prompts |

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

## Hooks

Two lifecycle hooks are registered in `.claude/settings.json`:

| Hook | Event | What it does |
|------|-------|--------------|
| `PreCompact` | Before auto-compaction | `git add -A && git commit --no-verify -m "auto-save: pre-compaction checkpoint"` — preserves session state across context resets. Note GH#13572: does not fire on manual `/compact`; the Stop hook covers that path. |
| `Stop` | After each Claude response | Reads `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, sums all four token fields, and appends a record to `~/.advisor/state/token-usage.jsonl` for cross-session cost tracking. |

## Iteration and spawn-fresh model

Workers self-terminate after delivering `result`. There is no in-session refinement. Every follow-up — including same-artifact tweaks — spawns a fresh worker:

```bash
bin/summon --agent <name> \
  --task "<refinement — existing file at outputDir>" \
  --goal "<done condition>"
```

Pass the previous `outputDir` in the task so the new worker can read and update the existing deliverable.

## Self-healing — lesson vault

The advisor learns from failure across sessions via a Reflexion-style post-mortem channel. When a worker delivers `verdict=blocked` with `material=yes`, `lib/channel.js synthesize --verdict blocked` emits a `LESSON EXTRACTION REQUIRED` block. The `/extract-lesson` skill turns the failure into a negative-polarity lesson note (one heuristic, one trigger, one anti-pattern) and writes it to `~/.advisor/vault/lessons/`.

Before writing a brief, the advisor queries the vault:

```bash
bin/advisor-vault search --text '<3 keywords from task type>'
```

Matching `[lesson]` entries are appended as a `Prior failure constraints:` block at the bottom of the brief, so the new worker inherits the constraint without rediscovering the failure mode.

**Trigger threshold:** lesson extraction is auto-triggered on the **2nd or subsequent** `overall_pass: false` evaluator verdict for the same task shape in a session — a single failure is treated as task-specific noise. Lessons are always negative-polarity (what to avoid); positive-polarity success notes are not stored.

The vault is backed by an FTS5 SQLite index at `~/.advisor/vault/.cache/index.sqlite` and indexes synthesis records, session notes, and lessons. All three are written automatically — no manual indexing step.

## Guardrails summary

- **Triage first.** Run the triage pre-pass before decomposing. Ratify if `confidence ≥ 0.7`; discard if below.
- **Brief specificity.** Before summoning, confirm two workers can't end up researching the same thing.
- **Synthesize before moving on.** Run `/synth` on every `result` before spawning a new worker or reporting to the user.
- **Spawn-fresh for follow-up.** Workers self-terminate; every refinement is a new `bin/summon` call.
- **Don't do the worker's job.** Delegate all multi-file edits, docs, tests, and code changes — including edits to this repo's own files.
- **Cascade test for prompt edits.** After editing CLAUDE.md or an agent prompt, run `diff-walker` to check for behavior regressions.

Full guardrails and the complete orchestration protocol are in `CLAUDE.md`.

## Prerequisites

**macOS Terminal.app profile configuration** — required for `bin/close-tab` to work.

Open Terminal.app → Settings → select your default profile → Shell tab → "When the shell exits" → set to **"Close if the shell exited cleanly"** (or "Close the window").

Without this setting, worker tabs linger with "Process completed" after workers finish.

## Tests

```bash
bash test/close-tab.test.sh
```

Expect: `3/3 PASS`.
