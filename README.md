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
3. bin/summon --agent <name> --task "..." --goal "..."  [--model <id>]
   └─ opens Terminal tab, seeds inbox, exports $INBOX/$OUTBOX/$OUTPUT_DIR/$ADV/$REPO
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
  close-tab           # close current macOS Terminal tab (called by workers on self-terminate)
  close-worker-tab    # close a specific worker's tab by SID (called by Advisor post-result)
  summon              # provision + open a worker session in a new Terminal tab
lib/
  channel.js          # append-only JSONL channel: send / recv / tail / synthesize
  session.js          # session plumbing: IDs, workspaces, session.json, output-dir logic
  summon.js           # Node core: provisions workspace, composes bootstrap prompt, writes launch.sh
agents/
  code-reviewer/      # (each contains CLAUDE.md that defines the worker's role)
  coder/
  creative/
  diff-walker/
  evaluator/
  frontend/
  philpsych/
  planner/
  researcher/
  triage/
skills/
  brief/              # /brief — validates fields and emits bin/summon command
  synth/              # /synth — validates fields and runs channel.js synthesize
  worker-protocol/    # /worker-protocol — inbox polling, tracing, self-terminate rules
.claude/
  settings.json       # Advisor harness config (permissions, hooks, env vars)
  hooks/              # SessionStart banner, PostToolUse session.json updater, statusline
~/.advisor/runs/<sid>/
  channel/inbox.jsonl   # Advisor → worker
  channel/outbox.jsonl  # worker → Advisor
  workspace/            # ephemeral copy of agents/<name>/ — the worker's cwd
  output/               # durable deliverables (self-invocation) or <repo>/.advisor-output/<sid>/
  meta.json             # session metadata (sid, agent, task, goal, outputDir, repo, …)
  session.json          # tier, decomposition status, next_action (recovery checkpoint)
  synthesis.log         # JSONL log of all synthesis records for this session
  bootstrap-prompt.txt  # prompt passed to the worker's claude invocation
  launch.sh             # shell entry point opened by osascript
  tty.txt               # worker's tty path (used by close-worker-tab)
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
| `coder` | Implements fixes from a structured spec; edits files in `$REPO` in place; produces `changes.md` |
| `creative` | Ground / Explode / Forge three-phase protocol for breaking fixation and generating non-obvious alternatives |
| `diff-walker` | Cascade-tests a CLAUDE.md prompt edit against a corpus of real tasks on 4 axes; produces `cascade-report.md` |
| `evaluator` | Scores a worker result on 5 rubric dimensions (factual accuracy, citation precision, completeness, source quality, tool efficiency); produces `scores.json` |
| `frontend` | Builds self-contained frontend deliverables (landing pages, components, static sites); verifies in browser before reporting |
| `philpsych` | Writes the character / behavioral section of an agent's system prompt using psychology frameworks (SDT, Big Five, CBT, Stoicism) |
| `planner` | Decomposes a task into a structured execution plan with subtasks, dependencies, and machine-verifiable DoD criteria; produces `plan.md` |
| `researcher` | Executes research tasks (library evaluation, trend scan, fact-finding); cites every non-trivial claim; produces structured reports |
| `triage` | Classifies a user prompt into a tier and emits a JSON decomposition seed; invoked via `--model claude-sonnet-4-6` for compatibility with auto mode |

## Skills catalog

Skills are installed to `~/.claude/skills/` by `bin/summon` and invoked with a slash command:

| Skill | Purpose |
|-------|---------|
| `/brief` | Validates 5 required fields (objective, output, tools, scope, parallelism) then emits a `bin/summon` command |
| `/synth` | Validates 4 required fields (sid, seq, established, gap) then invokes `channel.js synthesize` |
| `/worker-protocol` | Loads inbox-polling rules, tracing cadence, and self-terminate behavior into a worker session |

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
node lib/channel.js synthesize \
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

## Iteration and spawn-fresh model

Workers self-terminate after delivering `result`. There is no in-session refinement. Every follow-up — including same-artifact tweaks — spawns a fresh worker:

```bash
bin/summon --agent <name> \
  --task "<refinement — existing file at outputDir>" \
  --goal "<done condition>"
```

Pass the previous `outputDir` in the task so the new worker can read and update the existing deliverable.

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
