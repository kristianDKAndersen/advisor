# output-filter prototype — corrected measurement (advisor-verified)

**Date:** 2026-06-15 · branch `feat/output-filter-prototype`
**Estimator:** tokens ≈ chars/4 (stated). Inputs are REAL `bun test` output from this repo.

## Why this supersedes the coder's `measurement.md`

The Run-1 coder measured on a 696-byte input — **below the filter's own 2048-byte `minBytes` floor**, so `filter()` was a no-op passthrough. Its "filter PASS / compactor FAIL" was an artifact (filter preserved the line because it filtered nothing). Re-measured here on large output where the filter actually engages.

## Results

| Input (real `bun test`) | Raw | filter() | Reduction | compactor (200-char) |
|---|---:|---:|---:|---:|
| Full passing suite (1103 tests, 115 files) | 1417 tok | 433 tok | **69.4%** | 50 tok |
| Failure-heavy red-phase (87 tests, 7 real failures) | 1838 tok | 1013 tok | **44.9%** | 50 tok |

## Signal preservation (the metric that matters)

| | failure lines surviving |
|---|---|
| `filter()` | **22 / 28 — PARTIAL** |
| compactor `defaultSummarize` | **0 / 28 — total loss** |

## Findings

1. **Real reduction is 45–69% on this repo's output — not 95%.** The h5i 95% headline needs pathological input (17k-token logs); the advisor's actual runner (`bun test`) is *terse on success* (1103 tests → 85 lines / 5.7KB) and only verbose on failure. Honest expectation for advisor workers: meaningful but moderate.
2. **filter() massively beats the status-quo compactor on signal.** The PreCompact stub truncates to 200 chars and loses 100% of failure detail; filter keeps most of it. This is the real win — *preservation at a budget*, not raw token savings.
3. **DEFECT (must fix before production): assertion-diff lines are scored low and dropped.** `Expected: 9999` / `Received: 12` score 0.1 (no error keyword), so the most useful part of a failure can be folded/elided — only 22/28 survived. Fix: score lines *adjacent* to high-signal lines as high-signal (context window), and/or add `/^\s*(Expected|Received|at )/` to the high-signal patterns. The current scoring keeps `error:` and `(fail)` but can lose the actual expected-vs-actual values.

## Delivery-mechanism verification (Claude Code 2.1.177)

The auto-PostToolUse-interceptor delivery was tested end-to-end and **refuted**:

- A sentinel hook (`updatedToolOutput:"SENTINEL"`, exit 0) **fired** (stdin captured) in both `claude -p` and the framework's exact interactive launch (`claude --permission-mode auto ... -- "<prompt>"`), but the model **received the original output unchanged** both times. `updatedToolOutput` does not replace model-visible output on this version, contrary to the docs.
- The Bash raw output is in `tool_response.stdout`/`.stderr`, **not** `tool_response.output`. The prototype hook (and the existing `lib/hooks/worker-trace.js`) read the wrong field — a latent bug worth a separate fix.

**Consequence:** the auto-hook (`lib/hooks/worker-output-filter.js` + `summon.js` wiring) does not deliver filtered output on this version. The viable path is h5i's explicit **wrapper** (`capture <cmd>` → filtered summary on its own stdout, raw to `captures/`), which needs no `updatedToolOutput` and no output-replacing `settings.json`.

## Post-fix verification (advisor-run, after the capture-wrapper rebuild)

On a regenerated **6842-byte** failure-heavy real `bun test` capture (filter engaged, not passthrough):

- **Failure-line survival: 28/28** (was 22/28) after the scoring fix (`RE_ASSERT_DETAIL` for `Expected|Received|Actual|at ` + 2-line adjacency promotion). Verified independently of the coder's `measurement-v2.md`, which reused the unrepresentative 694-byte passthrough input.
- **Reduction: 56%** on that input.
- **`bin/capture`** (the delivery mechanism that replaces the dead hook): on a failing command it propagated **exit code 1**, printed the filtered summary + footer `187→101 lines; raw at <captures path>`, and wrote the raw log; on a small command it passed through unchanged at exit 0.
- **Full suite: 1115 pass / 0 fail / 1 skip** (1116 tests, 117 files) — no regression.

## Verdict

The filter **library** is sound and clearly beats the existing fallback on signal preservation. Status after rebuild: (1) benefit recalibrated to 45–69%, not 95%; (2) the assertion-diff scoring defect is **FIXED and verified (28/28)**; (3) the auto-hook delivery was **refuted on Claude Code 2.1.177** and **replaced by `bin/capture`** (explicit wrapper, verified). The dead hook + `summon.js` wiring are removed. **GO on the technique via the `capture` wrapper.** Remaining before production use: wire workers to invoke `capture` for noisy commands (agent-prompt change, deliberately out of scope here).
