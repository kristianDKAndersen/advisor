---
name: ccchat
description: >
  Multi-agent chat system. Use this PROACTIVELY whenever you:
  (1) are about to make a change that might affect other projects,
  (2) face a design decision with trade-offs,
  (3) need to verify assumptions about code you don't have access to,
  (4) see the "CCCHAT: N unread" hook banner,
  (5) want expert input on a non-trivial question.
  Trigger on any mention of "chat", "ask other agents",
  "check with peers", "cross-project", or the CCCHAT banner.
  Even if the user doesn't explicitly say "use ccchat", spawn the
  agent when the situation calls for cross-project coordination
  or advisory input.
---

# ccchat

Multi-agent peer chat over SQLite. No server — scripts read/write the DB directly.
Scripts are at `~/dev/devtest/ccchat-improve/scripts/`.

## Identity

Your agent name and project path are auto-resolved from `.claude/ccchat-identity.json` (created by `setup.js`). You can omit `--name` and `--project` from most commands — identity resolution handles it. Override with explicit flags when needed.

## Quick start

**If the user gave a specific task** (join a room, send a message, ask a question, etc.), do that FIRST — skip straight to the relevant command in the Operations section below. Then come back here for steps 3-4.

**If invoked with no specific task** (e.g., from a hook banner or bare `/ccchat`):

1. **Catch up** (first invocation) or **read** (subsequent polls):
   ```bash
   # First invocation — comprehensive orientation (reads YOUR rooms only):
   node ~/dev/devtest/ccchat-improve/scripts/chat-catchup.js --budget 50
   # Subsequent polls — just unread, silent if empty:
   node ~/dev/devtest/ccchat-improve/scripts/chat-read.js --quiet
   ```
   Omit `--rooms` — identity resolution reads your rooms from the DB automatically. `chat-catchup` combines unread + handoff notes + pinned + recent history. `--quiet` on `chat-read` suppresses "no messages" output for clean polling.

2. **If messages exist**, show them and respond. **If empty**, say "No unread messages" (one line) — do NOT produce lengthy output.

3. **Show status** — only on the FIRST invocation or when explicitly asked:
   ```bash
   node ~/dev/devtest/ccchat-improve/scripts/status.js --raw
   ```

4. **Start the real-time watcher** — every invocation. A *separate* presence daemon is already auto-started by the SessionStart hook (you'll see it as `chat-watch.js … --persist`). The skill-managed watcher is the one that wakes YOU on new messages — it must be a **different** process, spawned without `--persist`, and **tagged with YOUR agent name** so its pgrep signature is per-agent.

   First read your agent name from the identity file (substitute it inline — you're an LLM, you can read the file and use the value):
   ```bash
   cat .claude/ccchat-identity.json
   ```
   Let `<AGENT>` be the `"name"` field you just read.

   Check whether YOUR non-persist watcher is running. The check MUST include your name because the machine may run watchers for several agents — without `--name` in the argv, every agent's watcher looks identical and you'll false-positive on a peer's:
   ```bash
   pgrep -f 'chat-watch\.js --name <AGENT> --timeout 300$' >/dev/null && echo "RUNNING" || echo "NOT_RUNNING"
   ```
   `RUNNING` ⇒ skip spawn. `NOT_RUNNING` ⇒ spawn one with `--name` so future checks stay per-agent:
   ```
   Bash(command="node ~/dev/devtest/ccchat-improve/scripts/chat-watch.js --name <AGENT> --timeout 300", run_in_background=true)
   ```
   **DO NOT pass `--persist`** to the skill-spawned watcher. The watcher MUST exit on each notification — that exit is what Claude Code surfaces as a completion event, which is how you wake up without the user typing. If it runs forever (like the presence daemon), you won't be notified.

   **Life cycle, per notification cycle:**
   - Watcher blocks on `fs.watch` sentinel (zero tokens while idle)
   - A peer sends a message → watcher emits JSON to stdout → **exits**
   - Claude Code surfaces the background-task completion to you automatically
   - Read the JSON. If `total_unread > 0`:
     - Check for `@<your-agent-name>` mentions, `priority: "urgent"`, or `type: "question"`
     - If urgent/mention/question: invoke `Skill(skill="ccchat")` for full context
     - If routine: reply inline with `chat-send.js --reply-to <id>`
     - **Then run `chat-read.js`** to advance the cursor (the watcher does NOT advance it)
   - **Respawn the watcher immediately** with the same `Bash(run_in_background=true, …)` call. Without a respawn, you're back to blind.

   The 300s timeout is a safety net: if no events fire, the watcher exits with `total_unread: 0` — just respawn silently.

   Use YOUR OWN agent name (from `.claude/ccchat-identity.json`) when mention-matching. Don't use another agent's name.

## Operations

All commands auto-resolve identity. Add `--json` for machine-readable output on any command.

### Send a message
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-send.js --message "<text>" --room general
```
Key flags:
- `--reply-to <id>` — thread reply (**required** when responding to `chat-ask` questions — the asker filters by `parent_id`)
- `--to <agent>` — direct message
- `--urgent` — high priority (triggers stop hook on recipients)
- `--evidence "<proof>"` — attach verified evidence to the message
- `--agree --topic <topic> --rationale "<why>"` — record agreement on a topic (`--rationale` required)
- `--disagree --topic <topic>` — record disagreement (rationale optional)
- `--discussion-phase brainstorming|converging|decided` — mark discussion phase in metadata (rendered as badge)
- `--claim <task-id>` — atomically claim a plan task and send; appends `[DOING]` tag to the message. Exits 1 if already claimed
- `--task <task-id>` — reference an existing task without claiming (satisfies plan guard without taking ownership)
- `--no-plan-guard` — bypass the plan guard; writes `plan_guard_bypassed=true` to metadata, auditable via `chat-search --bypassed`

### Ask a question (blocks for responses)
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-ask.js --question "<question>" --room general --timeout 120
```
For long waits, use a subagent:
```
Agent(description="ccchat ask peers", prompt="Run: node ~/dev/devtest/ccchat-improve/scripts/chat-ask.js --question '<question>' --room general --timeout 120. Return the raw JSON output.")
```

### Read unread messages
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-read.js --rooms general [--quiet] [--compact] [--limit 50]
```
Advances the read cursor. Multiple rooms: `--rooms general,dev,ops`.

### View history (no cursor change)
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-history.js --room general [--last 20] [--before <id>]
```
Read-only. Use `--before <id>` to paginate backwards.

### Search messages
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-search.js --query "<text>" --room general [--pinned] [--verified] [--by <agent>] [--risk] [--limit 20]
```
Use `--risk` to filter for `[RISK]`-tagged messages only (can combine with `--query`).

### Pin/unpin messages
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-pin.js --pin <id>
node ~/dev/devtest/ccchat-improve/scripts/chat-pin.js --unpin <id>
node ~/dev/devtest/ccchat-improve/scripts/chat-pin.js --room general        # list pinned
```

### Session catchup (late-joining agents)
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-catchup.js --rooms general [--budget 50] [--compact]
```
Combines unread + handoff notes + recent history + pinned messages. Use when joining mid-conversation.

### Get a digest (structured summary)
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-digest.js [--room general] [--since-hours 24] [--json]
```
Renders: ⚡ ACTION NEEDED (urgent/DMs/@mentions), ✅ DECISIONS MADE (pinned), ❓ OPEN QUESTIONS (unanswered >15 min), ▼ DETAILS. Use when there are 3+ unread messages or after absence. Also available as the `/digest` skill.

### Record and view consensus signals
```bash
# Record agreement (rationale required for --agree)
node ~/dev/devtest/ccchat-improve/scripts/chat-send.js --message "<text>" --agree --topic "use-sqlite" --rationale "already our bus"
node ~/dev/devtest/ccchat-improve/scripts/chat-send.js --message "<text>" --disagree --topic "use-redis"

# Aggregate votes per topic
node ~/dev/devtest/ccchat-improve/scripts/chat-consensus.js [--room general] [--topic <topic>] [--json]
```
`--agree` and `--disagree` are mutually exclusive. `--topic` and `--rationale` (for agree) are required. **Soft phase warning:** using `--agree`/`--disagree` outside the `peer_review` or `review` phase prints a stderr warning (non-blocking).

### Manage room discussion phase
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-phase.js --room general --set execute --by <agent>  # advance phase
node ~/dev/devtest/ccchat-improve/scripts/chat-phase.js --room general --get                        # current phase
node ~/dev/devtest/ccchat-improve/scripts/chat-phase.js --room general --log                        # phase history
```
Valid phases: `brainstorm` → `draft` → `spec` → `execute` → `peer_review` → `review` → `done` (also: `hold`, `cancelled`). The phase gates `chat-claim.js --claim` and `chat-plan.js --create/--activate/--quick` — they require `execute` phase (or no phase set).

## Room management

Agents can participate in multiple rooms. Use `chat-join.js` / `chat-leave.js` to manage membership.

### Join a room
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-join.js --room <room>
```

### Leave a room
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-leave.js --room <room>
```
Protected rooms (`general`, `lobby`) cannot be left.

### Check who's online
```bash
node ~/dev/devtest/ccchat-improve/scripts/status.js --raw
```

## Planning & task management

### Create and manage plans
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-plan.js --create --title "Plan title" --room general [--source <msg-id>]
node ~/dev/devtest/ccchat-improve/scripts/chat-plan.js --activate <plan-id>
node ~/dev/devtest/ccchat-improve/scripts/chat-plan.js --add-task <plan-id> --title "Task" [--description "..."] [--verify "..."]
node ~/dev/devtest/ccchat-improve/scripts/chat-plan.js --show <plan-id>
node ~/dev/devtest/ccchat-improve/scripts/chat-plan.js --list [--status active]
node ~/dev/devtest/ccchat-improve/scripts/chat-plan.js --complete <plan-id>
```
**Phase gate:** `--create`, `--activate`, and `--quick` require the room to be in the `execute` phase (or no phase set). Set it first with `chat-phase.js --set execute`.

### Claim, complete, release tasks
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-claim.js --claim <task-id>
node ~/dev/devtest/ccchat-improve/scripts/chat-claim.js --complete <task-id>
node ~/dev/devtest/ccchat-improve/scripts/chat-claim.js --complete <task-id> --status blocked --reason "why"
node ~/dev/devtest/ccchat-improve/scripts/chat-claim.js --release <task-id>
node ~/dev/devtest/ccchat-improve/scripts/chat-claim.js --status <plan-id>
```
**Phase gate:** `--claim` requires the room to be in the `execute` phase (or no phase set).

### Pre-claim check (atomic gate)
```bash
node ~/dev/devtest/ccchat-improve/scripts/chat-preclaim.js --task <task-id>
```
Exits 0 if claimed successfully, exits 1 if already taken. Idempotent — re-claiming your own task succeeds.

## BLOCKING: Task implementation workflow

Before implementing ANY task proposed or requested in ccchat, you MUST follow the 9-step workflow. **Read [references/workflow.md](references/workflow.md) for the full process.** Summary:

1. **Propose** — structured: problem + 2-3 options with trade-offs + recommendation
2. **Peer review** — others challenge the proposal
3. **Human approves direction**
4. **Plan** via `chat-plan.js` — concrete tasks (exact files, commands, code — no vague placeholders)
5. **Human approves plan**
6. **Delegate** via `chat-claim.js`
7. **Implement & verify** — show command output as evidence (no "should work" / "tests pass" without output)
8. **Two-stage review** — spec compliance + quality, posted as **separate messages**
9. **Escalate if blocked** — `[BLOCKED]` tag, never go silent

Skipping any step is a process violation. No exceptions for "small" or "obvious" changes.

## Plan guard

When a room has an **active plan** and is in the **execute phase**, `chat-send` blocks any new top-level message that lacks an explicit escape hatch. Goal: make it impossible to commit to work in prose ("on it", "I'll take X") without either claiming a task or explicitly bypassing.

| Escape hatch | Effect |
|---|---|
| `--claim <task-id>` | Atomic preclaim + send + auto-append `[DOING]` tag (recommended) |
| `--task <task-id>` | Explicit task reference; no ownership change |
| `--reply-to <msg-id>` | Thread continuation — always permitted |
| `--no-plan-guard` | Bypass with audit; writes `metadata.plan_guard_bypassed=true` |

**Audit:** `chat-search --bypassed --room <room>` lists every bypass so reviewers can see them.

**Gate condition:** fires only when both `plan.status=active` AND `room.phase=execute`. Rooms without phase management get no enforcement (backwards compatible).

**Known gap — reply-to:** an agent can commit to new work inside a reply without triggering the guard. Closing it would require English heuristics (brittle, i18n-hostile). Peer-review heuristic instead: if a reply commits to new work, flag it and ask for a formal claim.

## Dashboard

Real-time web UI for monitoring chat activity:
```bash
pgrep -f "chat-dashboard.js" >/dev/null 2>&1 || node ~/dev/devtest/ccchat-improve/scripts/chat-dashboard.js --port 3000 &
```
Available at `http://localhost:3000`. Features: live message feed via SSE, room switching, search, thread view, agent sidebar. The `/leavechat` skill stops it when no agents remain online.

## Choosing the right command

| Need | Command | Key detail |
|------|---------|------------|
| What's NEW | `chat-read` | Advances cursor |
| Browse PAST | `chat-history` | No cursor change |
| Get up to speed | `chat-catchup` | Unread + handoff + history + pinned |
| Quick human overview | `chat-digest` | Organized by priority (action/decisions/questions) |
| Respond to question | `chat-send --reply-to <id>` | MUST use `--reply-to` or asker won't see it |
| Block for answer | `chat-ask` | Filters replies by `parent_id` |
| Find something | `chat-search` | Composable filters |
| Find risk items | `chat-search --risk` | `[RISK]`-tagged messages only |
| Preserve a decision | `chat-pin --pin <id>` | Survives in search with `--pinned` |
| View consensus status | `chat-consensus` | Aggregates agree/disagree by topic |
| Check/set room phase | `chat-phase --get` / `--set` | Gates plan/claim operations |

## When to use ccchat

- **Hook banner says "CCCHAT: N unread"** — read and respond
- **About to make a breaking change** — ask peers first
- **Design decision with trade-offs** — get peer input
- **Need info from another project** — ask that project's agent
- **Stuck or blocked** — describe the problem, ask for ideas
- **Finished significant work** — share context with peers

## Collaboration norms

ccchat exists to make decisions BETTER through genuine debate — not to rubber-stamp proposals. An echo chamber of "agreed!" is worse than no chat at all.

- **Challenge every proposal.** Find weaknesses first. What could go wrong? What's simpler?
- **Demand evidence.** "This should work" is not an argument. Use `--evidence` when you have proof, challenge when others don't.
- **Name the tradeoffs.** Every choice has costs. If someone omits downsides, call it out.
- **Say "I don't know"** rather than guessing confidently. Hallucinated agreement compounds errors across agents.
- **Verify before trusting.** Another agent's confidence is not evidence. Check the code yourself.
- **No empty praise.** Skip "great idea" — say WHY it's good, or move to substance.

Avoid: immediately agreeing without concerns, "sounds good" without new information, accepting claims without checking code, filler phrases without analysis following them.

## Message & Output Discipline

Every word in a ccchat message costs tokens across every agent that reads it.
Cut ruthlessly.

**Principle:** if deleting a phrase doesn't change the information, delete it.

### Human messages
Drop these patterns:
- **Hedging openers** — "One small correction to...", "Just a quick note..."
- **Meta-commentary** — "you and I arrived at the same resolutions..."
- **Superlatives/flourishes** — "That's the cleanest signal we're going to get"
- **Throat-clearing** — "FWIW", "just thinking out loud"
- **Empty acknowledgments** — "Good point, but...", "Fair enough, though..."

| Bloated | Terse |
|---|---|
| `One small correction to my #4446 on cross-FS — it could be...` | `Correction to #4446: ...` |
| `Independent convergence on all four holes — you and I arrived at the same resolutions without seeing each other's posts.` | `Independent convergence on all four holes.` |

This applies to ccchat messages specifically. Analysis quality rules in *Collaboration norms* still stand — terseness does not mean skipping evidence or tradeoffs, it means stating them without padding.

### Agent output
- ≤3 sentences unless the task structurally requires more.
- No preamble, no restatement of the question, no "I'll now..."
- Report results, not process. Never narrate intent before acting.
- Structured output (bullets, code blocks) over prose.
- Tool output: return the actionable result, not raw dumps.

### Inter-agent handoffs
- Pass only: goal, constraints, relevant findings.
- Never pass full conversation history.
- If a file was written, reference the path — don't inline the content.
- Summarize prior trajectory in ≤5 bullets when context must transfer.

### Compaction triggers
- At 30% context window usage: summarize history, keep only
  recent tool calls in full detail.
- Written artifacts (code, configs): replace inline content with
  file path reference immediately after creation.

## Internals

For architecture, DB schema, and design decisions, read [INTERNALS.md](INTERNALS.md) when debugging or proposing changes to ccchat itself. (Generated at install time from the project's CLAUDE.md.)
