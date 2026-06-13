---
scope: "Root of the advisor repo — overall architecture, entrypoints, and cross-cutting rules"
last_updated_by: "sid:1781304118-fd6647 seq:3"
last_updated_ts: "2026-06-13T15:15:44Z"
---

# Advisor — Root

The advisor is an AI-orchestration system that summons coder workers, manages sessions, synthesizes results, and maintains a living AGENTS.md tree across the repo.

## Key entrypoints

- `lib/summon.js` — provisions and launches worker sessions (coder workers, doc-agent, etc.)
- `lib/channel.js` — append-only JSONL channel for Advisor↔worker messaging; also runs the `synthesize` sub-command
- `claude.md` — advisor-level CLAUDE.md with session bootstrap prompt and tool permissions

## Doc-agent pipeline

After each coder-worker session closes, `channel.js synthesize` collects `modified_files` from the worktree-scoped git diff and enqueues a synthesis record to `~/.advisor/doc-queue.jsonl`. The doc-agent then processes these records to update AGENTS.md files.

## Frontmatter linting

Every AGENTS.md in the tree must pass `lib/hooks/agents-md-lint.js`. Rules LR-1 through LR-6 require a valid YAML frontmatter block with `scope`, `last_updated_by` (`sid:<sid> seq:<seq>` format), and `last_updated_ts` (ISO 8601 UTC).

## Spawned agents

Agent definitions and CLAUDE.md prompts live in `spawns/<agent-name>/`. The doc-agent definition is at `spawns/doc-agent/CLAUDE.md`.
