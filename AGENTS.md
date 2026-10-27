---
scope: "Root of the advisor repo — overall architecture, entrypoints, and cross-cutting rules"
last_updated_by: "sid:1793109359-991d3b seq:1"
last_updated_ts: "2026-10-27T13:56:13Z"
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

## Quality and publish gates

CLIs in `bin/` that check a branch before anything outward-facing. Workers may dry-run `advisor-publish` but never pass `--execute`. The hook `lib/hooks/publish-guard.js` blocks raw `git`/`gh` publish commands; see `lib/AGENTS.md`.

- `bin/advisor-publish` — publish gate: push / PR body / PR comment / review replies only after the review, claims, artifact and policy checks pass for the PR at HEAD; a dry run unless `--execute`; GitHub hosts only; stops the ordinary publish path, not a sandbox (header comment, lines 1-5)
- `bin/advisor-claims-check` — verifies a `claims.md` ledger (`| id | sentence | evidence_type | evidence | sha |`) against texts at HEAD; exit 3 `STALE_LEDGER`, 4 uncovered sentence or absolute without exhaustive evidence, 5 `DANGLING_CITE` (lines 2-18)
- `bin/advisor-conventions` — builds a repo-rules digest `conventions-digest.md` from tracked CLAUDE.md / AGENTS.md / REVIEW.md, CONTRIBUTING*, PR template, CODEOWNERS and lint configs; read-only on the target repo (lines 2-17)
- `bin/advisor-prose-lint` — enforces the measurable prose rules from that digest's `## Measurable rules` yaml fence on added lines of `git diff <base>..HEAD` or on `--text` files; no built-in defaults (lines 2-10)
- `bin/advisor-matrix-lint` — validates the `### Guard matrix` table in a `changes.md` or `plan.md`: no empty cells, test IDs found by `git grep -F`, `N/A` / `OUT OF SCOPE` with a reason; read-only (lines 2-17)
- `bin/advisor-revert-check` — hunk-revert mutation check: reverse-applies each non-test, non-doc hunk of `git diff -U0 <base> <head>` in a scratch worktree, runs `--test-cmd`, classifies KILLED / ERROR / SURVIVED / TIMEOUT / NOT_RUN (lines 2-16)
- `bin/advisor-repo-hygiene` — finds what advisor runs leave in a target repo (`TRACKED_RESIDUE`, `STALE_WORKTREE`, ...); read-only unless `--execute` (lines 2-7)
