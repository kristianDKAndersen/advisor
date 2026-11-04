---
scope: "tests/ — automated test suite for the advisor library modules, binaries and hooks, including the handover and maintenance tests"
last_updated_by: "sid:1793787710-da09d0 seq:1"
last_updated_ts: "2026-11-04T10:22:45Z"
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

## handover-header.test.js

Unit tests for `lib/handover.js`: `classifyContent()` for header-open, header-resolved, legacy line-start and heading resolution, legacy mid-line mentions, invalid reasons (unclosed header, bad status, bad or future `created`), empty content, CRLF/BOM, duplicate keys and opening fences with trailing space or tab; `applyHeaderUpdates()` body preservation, newline injection and trailing-space fences found with their bytes kept; `renderHeader()` key order; `atomicReplace()` and `createExclusive()` (no leftover tmp, `-2` suffix, no overwrite).

## handover-write.test.js

CLI tests for `bin/handover-write`: help and usage exit codes, headered open file creation under `plans/`, embedded `session.json` snapshot and stdin notes, sid resolution order (`--sid`, `ADVISOR_SID`, newest valid run dir) with the source reported on stderr, `--no-session`, same-second name suffixes, sanitisation of hostile slugs and sids, symlinked `plans/` exit 3, empty stdin, no `link()` use, and timezone-independent `created`. Every spawn sets `ADVISOR_RUNS_ROOT` to a temp dir.

## session-start-handover.test.js

Tests for the handover banner in `.claude/hooks/session-start.js`: OPEN, STALE, open-count, stale-archived and resolved-archived lines, the INVALID line (reasons, at most five names then `+m more`), young empty files, the scan-failed line for an unreadable `plans/` and for a symlinked `plans/` (ELOOP, target left untouched), silence for a missing `plans/`, the 7d STALE boundary (7d-60s OPEN, 7d+60s STALE, headered and legacy), the resolved-archive failure line with no stale-open failures, exact line texts, and the archive-failure line while the hook still exits 0. Each spawn uses temp dirs for `ADVISOR_RUNS_ROOT` and `ADVISOR_VAULT`.

## handover-docs.test.js

Doc-consistency checks: `.claude/skills/pre-compact/SKILL.md` calls `bin/handover-write`, has no `node -e` snippet, passes `--sid` and notes via a stdin heredoc, carries a `last_edited` date of 2026-10-28 or later, and its recovery section names the status header, the 30-day archive and `bin/handover-resolve`; `decisions/doctrine-changelog.md` has a 2026-10 handover entry. Reads files with `node:fs`.

## handover-resolve.test.js

CLI tests for `bin/handover-resolve`: appends `FINAL OUTCOME` for a legacy file so maintenance stops listing it as open, leaves unresolved siblings open, refuses double resolve (exit 4, first outcome kept), requires an existing file and a non-empty `--outcome`, rewrites headers (status, resolved epoch, outcome) with body bytes identical, single-line and 200-character-capped outcomes, invalid header exit 2 unmodified, symlinked file or `plans/` directory exit 3 with nothing changed, unreadable file exit 2 (skipped as root), closing fence with trailing space resolved with its bytes kept, `_archive` path exit 2, relative and `..` paths resolving to the same file, and no recreation when the target is removed before rename. Every spawn uses a temp `ADVISOR_RUNS_ROOT`.

## maintenance.test.js

Tests for `lib/maintenance.js`: `pickLastSession()` selection and null case; `newestUnresolvedHandover()` ordering (headered by `created`, legacy by mtime) and skipping of invalid and empty files; `archiveResolvedHandovers()` (24h floor, header `resolved` epoch over mtime, `resolved-24h` reason, failure reporting when `_archive` is a file); `archiveStaleOpenHandovers()` (30-day boundary, `stale-30d` header and `ARCHIVED-STALE` legacy line, no overwrite of archived names, skip of files another session already moved, failure reporting when `_archive` is a file; age is max(created, mtime), so an edited handover resets its clock; a future mtime is clamped to now; `isArchiveDue()` boundaries at 24h and 30d; a 600-entry run where the archiver drains the oldest 100 while `newestUnresolvedHandover()` still returns the newest); `runHandoverMaintenance()` (plain scan when nothing is due, archive then rescan, a file another session moves between the scan and the archive step is not reported as open); pre-scanned `items` honoured by the archivers and `scanHandovers()`; `cleanupHandoverTemps()` in `_archive/`, keeping young tmp files and empty reservations and skipping a symlinked `_archive/`; a symlinked `plans/` gives ELOOP with the archivers and temp cleanup touching nothing; `archiveStaleReminders()` plus an integration run of `session-start.js` under node; `listHandovers()` classification; `scanItems()` newest-plus-oldest cap; `scanHandovers()` counts, reasons, unreadable-vs-missing `plans/`, and the 7d `staleCount` boundary (exactly 7d is not stale, 7d+1s is).
