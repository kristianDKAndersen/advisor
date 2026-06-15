# h5i Token Reduction — Evaluation for the Advisor Framework

**Date:** 2026-06-15
**Question:** Is h5i's "up to 95% less token waste" claim real, and is the technique worth adopting in the advisor framework?
**Verdict:** Claim is **half-true**. Technique adoption: **conditional go — narrow scoped pilot only.** Do NOT adopt h5i itself; port one technique for a specific worker class.

---

## 1. What h5i actually does

`h5i capture run -- <cmd>` is a deterministic, per-call wrapper around a shell command:

1. Executes the command, buffers raw stdout+stderr, preserves the exit code.
2. Stores the **full raw bytes** content-addressed in git (`.git/.h5i/objects/…`), recoverable later via `h5i recall object <id>`.
3. Returns to the agent only a **compact summary**, produced by a no-model, no-network filter:
   command-aware adapters (pytest/cargo/tsc/ruff/…) → line scoring 0.0–1.0 (errors=1.0, warnings=0.7, noise=0.1) → fold near-identical lines into `(×N)` → keep all high-signal lines + first 12 + last 12 → cap to ~80 lines.
4. Also emits a normalized `ToolResult` ("Unified Form") with `status` derived from exit code, structured `findings`, and `fingerprint`.

**Timing is the crux: filtering is per-call, in-loop, synchronous** — it runs before each tool result re-enters the agent's context. The agent never holds raw bytes. (Git-LFS `share push` is a separate, manual handoff step, not part of the per-call path.)

## 2. Is the 95% claim true? — Half-true

The 95.8% figure is **reproducible and honest within its own test matrix**, but does not survive as a general claim:

| Weakness | Evidence |
|---|---|
| Tiny, synthetic corpus | N=8 fixtures, all hand-built shell scripts designed to exhibit the filter's strengths |
| One fixture dominates | A single 17k-token noisy log = 64% of all savings. Remove it → aggregate drops to **~90%** |
| Strong-suit bias | 6/8 fixtures are noise-dominated (logs/tests/JSON). The 2 diagnostic-dense cases (ruff, mypy linters) reduce only **14% and 27%** |
| Self-defined denominator | "token waste" = raw tool-output tokens, assuming the agent would otherwise ingest 100% raw. Any existing filtering shrinks the marginal benefit |
| Misleading framing | "up to 95%" reads as a best-case ceiling; 95.8% is actually the *aggregate*, range is 14–100% |

**Honest restatement:** 88–100% reduction on large noisy test/build/log output; 14–30% on signal-dense diagnostics. The headline is best-case marketing when generalized.

## 3. The delta vs. the advisor framework

The advisor **already implements the half of h5i that mirrors "Unified Form" — at the handoff boundary.** A worker's `result` envelope is a ≤200-char `summary` + `paths[]`; full deliverables live in `outputDir` and never auto-enter advisor context (`lib/channel.js:104-122`). That is the same "compact in context, full output retrievable out-of-band" pattern.

**The gap is timing.** The advisor compacts **only at worker→advisor handoff**. Within a worker's own run, every Bash/Read/Grep/WebFetch result accumulates **raw and unfiltered** in that worker's local Claude Code context until either the worker finishes or the reactive `PreCompact` hook fires (which only blunt-truncates to 200 chars/message — lossy, not intelligent). h5i closes exactly this gap: it filters **per tool call, in-loop**.

| | h5i | Advisor today |
|---|---|---|
| Handoff-boundary compaction | ✓ (manifests/summaries) | ✓ (synthesis: summary+paths) |
| **Per-call in-loop filtering** | **✓ (`capture run`)** | **✗ (raw accumulates)** |
| Raw recoverable out-of-band | ✓ (git object store) | ✓ (outputDir / disk) |
| Deterministic, no extra model cost | ✓ | n/a |

## 4. Recommendation — conditional go, scoped pilot

**GO (narrow):** Port the *technique*, not the binary. Build a small deterministic output-filter wrapper script (the rtk/headroom line-scoring + fold + head/tail approach is Apache-2.0 and already proven) that a worker invokes explicitly for known-noisy commands — e.g. `capture bun test` instead of `bun test` — writing raw output to `$OUTPUT_DIR/captures/<id>.log` (recoverable) and returning only the summary to the worker's context.

> **Confirm before porting code:** the claim that the upstream `rtk`/`headroom` line-scoring code is Apache-2.0 was read from h5i's own docs, not verified at source. Check the upstream licenses directly before reusing any of their code.

Scope it to where the technique actually pays off:
- **Target:** `coder`, `frontend`, `migration` workers — they re-run test suites and builds, the 88–100% case. This also dovetails with the TDD-first red/green evidence those agents must paste.
- **Do NOT target:** `researcher` / `deep-researcher` — their tool output is Read/Grep/WebFetch prose, the 14–27% diagnostic-dense case, low payoff.
- **Mechanism — auto-interceptor REFUTED empirically; use the explicit wrapper.** I initially favored an automatic PostToolUse interceptor (replace tool output via `updatedToolOutput`) based on the docs. **End-to-end testing on the installed Claude Code 2.1.177 refutes that contract** — in both headless (`claude -p`) and the framework's exact interactive launch (`claude --permission-mode auto ... -- "<prompt>"`), the hook fired and emitted `{hookSpecificOutput:{hookEventName:"PostToolUse",updatedToolOutput:"SENTINEL"}}` with exit 0, yet the model still received the original output unchanged. Separately, the Bash raw output arrives in `tool_response.stdout`/`.stderr`, **not** `tool_response.output` as the docs (and the existing `worker-trace.js`) assume. So the auto-hook delivery does not work on this version. **Viable delivery = h5i's actual model: an explicit opt-in wrapper** — workers run `capture bun test` and the wrapper prints the filtered summary to its own stdout (which the model sees natively) while writing raw to `$OUTPUT_DIR/captures/<id>.log`. This needs no `updatedToolOutput` and no output-replacing `settings.json`, so it also sidesteps the auto-mode classifier that blocked the hook install. Cost: workers must be instructed (via the brief/agent prompt) to prefix noisy commands with `capture`.

**NO-GO:**
- Adopting h5i itself (Rust + git-LFS at the git layer — wrong stack, wrong integration surface).
- Believing the 95% headline applies to the advisor's typical research workload (it doesn't — that's the noisy-log best case).
- Auto-intercepting all tool output, or building this for research-class workers.

**Effort/payoff:** A ~1-file filter script + a brief convention is a low-cost pilot. Expected real benefit: meaningfully longer coder/test sessions before context pressure, with raw logs still recoverable.

**Measurement gate (correct baseline):** Do NOT measure filtered-vs-raw token count — the advisor already runs a reactive `PreCompact` hook (`summon.js:348-350`), so raw is not the real baseline. Compare **per-call filtering vs. the existing PreCompact fallback**. PreCompact also cuts tokens, so token savings alone overstates the marginal benefit; the real differentiator is **signal preservation** — PreCompact blunt-truncates to 200 chars/message and can destroy the one error line that matters, whereas per-call filtering keeps high-signal lines verbatim. So the pilot's success metric is *output quality/completeness preserved at a given context budget*, not tokens saved. Measure on one real coder task before generalizing — do not repeat h5i's N=8 synthetic-fixture mistake.

## 5. Adjacent (flagged, not pursued)

h5i's **Context DAG** (`refs/h5i/context`) stores an agent's goal/milestones/OBSERVE-THINK-ACT trace in a git ref so a resuming agent inherits prior reasoning. This touches the advisor's existing handover mechanism (`~/.advisor/runs/plans/*-handover.md` + session-start surfacing), not token reduction. Separate evaluation if of interest.

---

*Sources: deep-researcher session 1781529737-ceac3c (`h5i-token-reduction-findings.md`), researcher session 1781529753-81adb8 (`advisor-context-baseline.md`). h5i clone at /tmp/h5i-clone.*
