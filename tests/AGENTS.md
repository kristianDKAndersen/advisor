---
scope: "tests/ — automated test suite for the advisor library modules"
last_updated_by: "sid:1793109249-9768ee seq:1"
last_updated_ts: "2026-10-27T13:54:30Z"
---

# tests/

Automated tests for advisor library modules. Run with `bun test` or equivalent.

## doc-enqueue.test.js

Integration tests for `channel.js synthesize` → `doc-queue.js` enqueue pipeline.

- `makeWorktree()` — creates a temporary git worktree for isolation
- `runSynthesize()` — invokes `channel.js synthesize` in a controlled worktree
- `readQueue()` — reads the queue file after synthesis
- Tests added in sid:1781303323-2aa9ef: verifies that `synthesize` correctly collects modified_files from the worktree git diff, skips enqueue when file list is empty, and tolerates try/catch-wrapped errors without aborting

## branch-guard.test.js

Unit and integration tests for `lib/hooks/branch-guard.js` (file at `tests/hooks/branch-guard.test.js`).

- `extractSid()` unit tests — null/undefined/empty INBOX, standard path, hyphenated sid, non-matching path (BG-0.1–BG-0.4)
- `runHook()` — invokes the hook CLI with synthetic stdin and optional env overrides
- `initGitRepo()` — creates a temporary git repo on a specified branch for isolation
- 14 tests covering fail-open cases (non-`Edit`/`Write` tool, missing `INBOX`, no sid, non-git workspace, detached HEAD) and the block/pass cases

## agents-md-lint.test.js

Unit tests for `lib/hooks/agents-md-lint.js`.

- `runLinter()` — invokes the linter CLI against a fixture file
- `runCommitGate()` — invokes commit-gate mode with synthetic stdin
- 27 tests covering LR-1 through LR-6 violations and valid-file pass cases (sid:1781304001-e1ba49)

## tests/advisor-claims-check.test.js

Tests for `bin/advisor-claims-check`: full coverage at HEAD exits 0; a stale row SHA exits 3 `STALE_LEDGER`; an uncovered sentence or an absolute without exhaustive evidence exits 4.

## tests/advisor-conventions.test.js

Tests for `bin/advisor-conventions`: the digest lists CONTRIBUTING, the PR template and nested CLAUDE.md with `path:line`; untracked files are ignored; commit-subject patterns and the measurable-rules block are derived.

## tests/advisor-matrix-lint.test.js

Tests for `bin/advisor-matrix-lint`: a valid matrix exits 0; a missing matrix exits 3 only with `--required`; an empty cell or an unjustified single row exits 4.

## tests/advisor-prose-lint.test.js

Tests for `bin/advisor-prose-lint`: `max_sentence_words`, `max_comment_sentences`, banned phrases and `max_line_length` / `file_max_lines` each exit 1 on a violation in added lines.

## tests/advisor-publish.test.js

Tests for `bin/advisor-publish`: usage and no-action exit 2; a clean audit at HEAD is a dry run that prints the push (exit 0); a commit after the audit exits 3; patch-id reuse after a clean merge of the target exits 0.

## tests/advisor-repo-hygiene.test.js

Tests for `bin/advisor-repo-hygiene`: `TRACKED_RESIDUE` (a file with only advisor lines is restored by `--execute`; one with a user line is left byte-identical) and `STALE_WORKTREE` (old detached or deleted worktrees are removed or pruned by `--execute`).

## tests/advisor-revert-check.test.js

Tests for `bin/advisor-revert-check`: usage and unresolvable ref; a guard with an asserting test is KILLED (exit 0), with a call-counting test SURVIVED (exit 1); a killed excerpt names the failing test.

## tests/channel-synthesize-integration-edits.test.js

Tests that `channel.js synthesize` requires `--integration-edits` (`none` or a description), stores it in the record and vault note, and prints it in the SYNTHESIS REQUIRED template (IE1–IE4).

## tests/hooks/publish-guard.test.js

Tests for `lib/hooks/publish-guard.js`: spec cases PG-1… block raw `git push` in a non-advisor repo, including after `cd <repo> &&` and with `git -C <repo>`.

## tests/hooks/worker-result-check-salvage.test.js

Tests that the worker-result-check Stop hook adds paths and `salvaged:true` to a `no_verdict` body when the outputDir holds files, and the plain body otherwise; the failure classification is unchanged.

## tests/sentences.test.js

Tests for `lib/sentences.js`: splitting on `.` `!` `?` with line tracking, wrapped-paragraph joining with start/end lines, fenced code skipping, and marker stripping.

## tests/session-local-exclude.test.js

Tests that a session-local exclude line goes into `info/exclude` (no `.gitignore` created, status clean), a second call returns false and adds no duplicate, `info/` is created when missing, and a linked worktree writes the common dir's `info/exclude`.

## tests/summon-gates.test.js

Pins the CB11 summon gates: skeleton-first write sentence for review agents (M7a), tier-scaled review timeouts (M7b), repo-rules digest pointer on non-advisor repos (M8), publish-guard in worker hooks (M1h).

## tests/synthetic-result-salvage.test.js

Tests `collectSalvagePaths`: an outputDir with `review.md` yields its absolute path; empty yields no `paths` or salvaged flag; output is sorted and recursive, excluding `trace.jsonl`, `captures/**` and `.spec-self-check/**`; the failure classifier still classifies a salvaged result.
