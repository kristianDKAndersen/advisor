# coder-cost eval

Frozen, re-runnable eval that measures **cost per completed task** and **pass rate**
for coder workers in this repo, so model/effort configs (A1) and the
elapsed-time instruction (D1) can be compared on real traffic. See
`.advisor-output/cost-optimize-20261005/cost-report.md` for the originating
decision context.

## What it measures

For each `(config, case, trial)` tuple:

- A fresh `claude -p` headless run is launched in an isolated git worktree
  checked out at the case's `base_sha`, with the case `brief` as the prompt.
- After the agent exits (or times out), the case's `hidden_tests` are copied
  in from `solution_sha` and run with `bun test`. The outcome is one of
  `pass | fail | timeout | error` — these are never collapsed into each other.
- Cost is computed **two ways** and compared:
  1. **Instrument A** — `total_cost_usd` / `usage` as reported by the CLI's
     own `--output-format json` result.
  2. **Instrument B** — recomputed from the session transcript (deduped by
     `message.id`) at the per-model list rates exported by
     `bin/advisor-cost` (`priceForModel`), with the 5m/1h cache-write split.
  A run where A and B differ by more than 5% is flagged
  (`cost_disagreement_flag`).

Cost is judged **per completed task** (a `pass` outcome), not per request —
see `report.js`'s "cost/solved task" column.

## Files

- `cases.jsonl` — frozen set of cases, one per line:
  `{id, base_sha, solution_sha, brief, hidden_tests[], timeout_sec}`.
  Mined from this repo's own history: commits that touch both an
  implementation file (`lib/` or `bin/`) and a `tests/*.test.js` file, kept
  only if the hidden tests mechanically **fail at `base_sha`** and
  **pass at `solution_sha`** (verified by actually running `bun test` in
  disposable worktrees — see `case-mining-log.md` for the full kept/dropped
  table and reasons).
- `configs.json` — model/effort/time-awareness configs under comparison.
- `run.js` — the runner (see Usage below).
- `report.js` — aggregates `results/*.jsonl` into a markdown report.
- `hooks/elapsed-time-hook.js` — PostToolUse hook used by the
  `*-timeaware` config (see "Time-aware config" below).
- `results/<run-id>.jsonl` — append-only result records, one run-id file per
  `run.js` invocation. Resuming re-scans **all** files in `results/`, so
  re-running after a partial run only executes the missing tuples.

## Adding a case

Add a line to `cases.jsonl` by hand, or extend the selection logic that
produced it (candidate commits were mined with
`git log --no-merges --format=%H -- lib/ bin/ tests/`, filtered to commits
touching exactly one `lib/`+`bin/` implementation change and 1-3
`tests/*.test.js` files, then mechanically verified fail-at-base/pass-at-
solution in disposable `git worktree`s). Keep `brief` as a natural-language
task description derived from the commit message/intent — never paste the
diff or the hidden test bodies into it.

## Cost warning

**Real model calls cost real money.** `run.js` without `--dry-run` invokes
the `claude` CLI once per `(config, case, trial)` and bills your account.
Always start with `--dry-run` to see the planned run count and a rough
cost estimate before spending anything. The full matrix (5 configs x 26
cases x 1 trial = 130 runs) is NOT something to run casually — budget and
confirm before doing so.

## Usage

```bash
# Plan + estimate only, spends nothing:
bun run.js --dry-run

# A single targeted run:
bun run.js --configs sonnet5-medium --cases case-001,case-002 --trials 1

# Full matrix (expensive — see Cost warning above):
bun run.js --configs sonnet5-medium,sonnet5-high,opus55-low,opus55-medium,sonnet5-medium-timeaware \
  --cases all --trials 1 --concurrency 2

# Aggregate whatever results exist so far:
bun report.js
```

Flags: `--configs <comma-list>` (default: all), `--cases <comma-list|all>`
(default: all), `--trials <n>` (default 1), `--concurrency <n>` (default 2),
`--dry-run` (plan + estimate, spends nothing).

## Time-aware config

`sonnet5-medium-timeaware` has two halves:

1. **Instruction half** (implemented, used in every turn): the system prompt
   is extended via `--append-system-prompt` with the text "Time matters
   here: do not spend time that can be avoided, and the earlier a correct
   result is obtained, the better. The elapsed time so far is shown before
   each of your turns."
2. **Per-turn elapsed-time half** (implemented, **not empirically verified**
   beyond the approved smoke run, which only exercises `sonnet5-medium`):
   `run.js` passes a per-run `--settings` JSON (time-aware config only) wiring a
   `PostToolUse` hook
   (`hooks/elapsed-time-hook.js`) that emits the documented
   `hookSpecificOutput.additionalContext` contract with the elapsed seconds.
   If this hook contract turns out not to fire in your CLI version, only the
   instruction half (1) is actually in effect — check a transcript for the
   injected context before trusting D1 results from this config.

## Outcome classification

- `pass` — agent exited without being killed for timeout, produced parseable
  JSON output, and the hidden tests passed afterward.
- `fail` — same, but hidden tests failed.
- `timeout` — the `claude` process itself was killed after `timeout_sec`
  wall-clock seconds (the hidden-test checker has its own shorter 120s
  timeout, also classified as `timeout`).
- `error` — the agent process errored (e.g. couldn't spawn), produced
  unparseable stdout, or the checker setup itself failed (e.g. couldn't read
  a hidden test file from `solution_sha`). Never conflated with `fail`.
