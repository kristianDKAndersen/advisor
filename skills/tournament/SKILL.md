---
name: tournament
description: Run a parallel TDD tournament — summon N coder workers each with a different strategy, evaluate all candidates against a shared test suite, and apply the winner. Use when you have a feature spec and want the best implementation selected objectively by test results.
last_edited: 2026-05-16
---

# Tournament

Run a parallel TDD tournament: spec agent writes failing tests, N coder workers implement the feature using different strategies, tournament-evaluator scores them, winner is applied to the repo.

## When to use

- Non-trivial feature where the "right" implementation is not obvious (e.g. multiple valid algorithmic or architectural approaches).
- Tests are practical to write first and can be run deterministically in a git worktree.
- Cost of N parallel coders (typically 3) is acceptable — each is a full worker session.
- You want an objective, test-result-backed selection rather than style judgment.

## Invocation

```bash
# Default three-strategy run:
bin/tournament --spec path/to/feature-spec.md

# Custom strategies:
bin/tournament --spec feature-spec.md --strategies "minimal-diff,idiomatic-refactor,defensive"

# Score and print results without applying changes:
bin/tournament --spec feature-spec.md --dry-run

# Keep loser worktrees for inspection after evaluation:
bin/tournament --spec feature-spec.md --keep-losers

# Provide a stable run identifier (useful for reproducing a run):
bin/tournament --spec feature-spec.md --run-id my-run-001
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Winner applied to repo |
| 1 | No candidate passed all tests |
| 2 | Spec phase failed (missing file, agent error, missing test_command) |
| 3 | Evaluator phase failed (agent error, scores.json missing or malformed) |
| 4 | Worktree creation failed |

## Gotchas

- Tests must be deterministic. Non-deterministic tests produce unreliable winner selection.
- The spec agent must emit a `test_command` that fails before any implementation lands (red). If the tests are already passing, the tournament produces no useful signal.
- The winner's diff is applied as-is. Review with `git diff` before committing — the evaluator does not check style, only test passage and diff size.
- Each coder works in its own isolated git worktree at /tmp/tournament-<run_id>-<strategy>. Workers cannot clobber each other. If the winner's patch does not apply cleanly (e.g. main repo drifted since worktrees were created), the orchestrator falls back to file copy and warns. Run `git status` clean before invoking to avoid patch conflicts.
- The `--keep-losers` flag retains loser candidate worktrees for debugging. Remove them manually with `git worktree remove` when done.
