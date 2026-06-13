---
scope: "tests/ — automated test suite for the advisor library modules"
last_updated_by: "sid:1781304001-e1ba49 seq:3"
last_updated_ts: "2026-06-13T15:15:44Z"
---

# tests/

Automated tests for advisor library modules. Run with `bun test` or equivalent.

## doc-enqueue.test.js

Integration tests for `channel.js synthesize` → `doc-queue.js` enqueue pipeline.

- `makeWorktree()` — creates a temporary git worktree for isolation
- `runSynthesize()` — invokes `channel.js synthesize` in a controlled worktree
- `readQueue()` — reads the queue file after synthesis
- Tests added in sid:1781303323-2aa9ef: verifies that `synthesize` correctly collects modified_files from the worktree git diff, skips enqueue when file list is empty, and tolerates try/catch-wrapped errors without aborting

## agents-md-lint.test.js

Unit tests for `lib/hooks/agents-md-lint.js`.

- `runLinter()` — invokes the linter CLI against a fixture file
- `runCommitGate()` — invokes commit-gate mode with synthetic stdin
- 27 tests covering LR-1 through LR-6 violations and valid-file pass cases (sid:1781304001-e1ba49)
