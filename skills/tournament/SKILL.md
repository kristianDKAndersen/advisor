---
name: tournament
description: Run a parallel TDD tournament — summon N coder workers each with a different strategy, evaluate all candidates against a shared test suite, and apply the winner. Use when you have a feature spec and want the best implementation selected objectively by test results.
last_edited: 2026-10-06
---

# Tournament

Run a parallel TDD tournament: spec agent writes failing tests, N coder workers implement the feature using different strategies, tournament-evaluator scores them, winner is applied to the repo.

## When to use

- Non-trivial feature with several valid approaches, where tests can be written first and run deterministically in a git worktree.
- The cost of N parallel coders (typically 3, each a full worker session) is acceptable.

## Invocation

```bash
bin/tournament --spec path/to/feature-spec.md [--strategies "minimal-diff,idiomatic-refactor,defensive"] [--dry-run] [--keep-losers] [--run-id <id>]
```

`--strategies` shows the default set. `--dry-run` prints scores without applying the winner. `--keep-losers` retains loser worktrees. `--run-id` gives a stable run identifier.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Winner applied to repo |
| 1 | No candidate passed all tests |
| 2 | Spec phase failed (missing file, agent error, missing test_command) |
| 3 | Evaluator phase failed (agent error, scores.json missing or malformed) |
| 4 | Worktree creation failed |
| 5 | Spec self-check failed (spec agent returned `verdict: blocked`) |

## Gotchas

- Tests must be deterministic, or winner selection is unreliable.
- The spec agent must emit a `test_command` that fails before any implementation lands (red); tests that already pass give no signal.
- The winner's diff is applied as-is. Review with `git diff` before committing - the evaluator scores test passage and diff size, not style.
- Each coder works in its own worktree under `/tmp/tournament-<run_id>-<strategy>`. If the winner's patch does not apply cleanly (main repo drifted), the orchestrator falls back to file copy and warns; start from a clean `git status`.
- Remove worktrees kept by `--keep-losers` with `git worktree remove`.
