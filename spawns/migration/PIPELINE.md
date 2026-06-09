# Migration Pipeline Architecture — v2

## Overview

The migration pipeline is **advisor-orchestrated**. Workers cannot summon workers; the advisor is the sole coordinator. The pipeline converts a source repository into a new-architecture codebase via an ordered sequence of atomic, tested commits, each corresponding to one behavior-coherent slice — expanded into exactly **two commits per slice** (literal + idiomatic).

Pipeline roles:
- **migration worker** (`migration`) — analyzes source repo, walks git history, produces the ordered slice plan.
- **advisor** — consumes the slice plan, fans out slices to a coder football team, monitors per-slice gates, and manages the slice ledger.
- **coder workers** (`coder`) — implement one slice each across two commits; must not cross slice boundaries; produce two atomic commits with passing equivalence tests.

Workers cannot talk to each other. All coordination flows through the advisor.

---

## Architecture Decisions

### Decision 1: Equivalence Gate Mode — per-SUBSYSTEM, requires user confirmation

Mode is detected **per subsystem** (not per whole repo). The migration worker auto-detects runnability per subsystem in Step 7.1 and tags each slice's mode accordingly. The advisor surfaces the per-subsystem assignment to the user before any coder is dispatched.

**Option A — RUNNABLE subsystem: golden-master / characterization tests**

How it works: the subsystem entry point is started. Representative inputs are fed in; outputs are captured as golden files. The new literal translation must reproduce those outputs. Golden capture happens in **Phase 0.5** before any coder dispatch.

Pro: catches undocumented behavior; golden files are auto-generated; strong parity signal.
Con: requires Phase 0.5 environment build (30–90 min); brittle against non-deterministic outputs (UUIDs, timestamps, sequence IDs) unless masked; cannot distinguish bugs from features.

**Option B — NOT RUNNABLE subsystem: contract / intent tests from arch_def + epics**

How it works: test cases are derived from arch_def, epics, and existing (non-runnable) source test files. Each test encodes a named behavior with explicit input/output expectations.

Pro: works when old system cannot be run; tests encode INTENDED behavior.
Con: cannot catch undocumented but implicitly required behaviors; higher false-green risk.

**Mixed mode (recommended):** Apply Mode A to subsystems that can be started in isolation. Apply Mode B to subsystems with unresolvable external dependencies. The migration worker produces the mode table; user confirms.

**Decision gate:** After the migration worker delivers `slice-plan.md`, the advisor presents the per-subsystem mode table and waits for user confirmation. No coder worker is dispatched until mode is confirmed.

---

### Decision 2: Fan-Out Mechanism — coder workers via direct summon (RESOLVED)

This decision was open in v1. It is now resolved.

**Context:** Two mechanisms exist for fanning out slices to a coder football team:

**Option A — Sub-teams skill with embedded coder discipline (role-prompt injection)**

How it works: The advisor invokes the `sub-teams` skill with role-prompts that embed the full coder protocol (TDD red/green, atomic commit, two-phase literal→idiomatic sequence, equivalence test cascade). The sub-teams skill spawns a delegator + N generic Task-tool teammates (model=sonnet).

Pro: structured state machine via `sub-teams/lib/`; aggregation via `state.json`; familiar skill interface.
Con: teammates are generic Task-tool agents, NOT real coder workers. They lack CLAUDE.md enforcement, tool-guard hooks (lib/tool-guard.js), spawn-team skill, and the environment discipline the coder's native protocol provides. The two-phase commit sequence is complex enough that generic agents executing an embedded role-prompt will produce higher error rates than agents whose primary role is coder. Embeds a fragile copy of the coder protocol that drifts over time.

**Option B — Advisor issues N parallel bin/summon --agent coder calls (RECOMMENDED)**

How it works: For each slice in the wave, the advisor runs `bin/summon --agent coder` with a per-slice brief. True coder workers are spawned — full CLAUDE.md, tools, and discipline loaded. Each coder handles both commits (literal Phase 1, idiomatic Phase 2) within a single session.

Pro: Full coder discipline enforced at the CLAUDE.md level — TDD red/green, atomic commits, changes.md evidence format, tool-guard hooks preventing test file mutation. The two-phase brief maps naturally to the coder's sequential workflow. Slice ledger tracks each coder's session ID and polls their outbox for results.
Con: Requires advisor to manage N outbox channels (one poll loop per coder session). No built-in state machine like sub-teams provides — advisor tracks state via slice ledger directly.

**Recommendation: Option B** — advisor issues N parallel bin/summon --agent coder calls.

Rationale: The two-phase (literal → idiomatic) commit sequence requires real git commits with verifiable red+green evidence at BOTH the literal and idiomatic boundaries. A generic sub-teams teammate can be instructed to make commits, but there is no enforcement mechanism (no CLAUDE.md, no tool-guard). A real coder worker's mandatory changes.md (with pasted failing and passing test output for each commit) provides machine-verifiable evidence for both commits. When a coder's idiomatic commit fails, the literal commit already exists in the new repo — the advisor can re-brief the coder for Commit 2 only, without re-running the literal translation.

**How two-phase maps onto a coder brief:**

```
Phase 1 (in coder brief):
  Task: Implement literal/unidiomatic translation of slice [S001] in target_location.
  Gate (cheap-first cascade):
    1. Whitespace diff: git diff --ignore-all-space shows changes (non-no-op)
    2. AST parse: <language check command> exits 0
    3. Build: <build command> exits 0
    4. Equivalence tests: <test_command> exits 0 (golden diff or contract tests)
  On gate pass: git commit -m "feat(migration): [S001-literal] <name> — unidiomatic behavior-preserving translation"
  Evidence required: paste failing run output (before implementation) + passing run output (after), both with command + exit code.

Phase 2 (in coder brief, after Phase 1 commit):
  Task: Refactor the literal translation to use <idiomatic_note> pattern. Do NOT change behavior.
  Gate: SAME equivalence test command as Phase 1 — must still exit 0.
  Verify idiom: grep/AST check confirms <idiomatic_note> pattern is present.
  On gate pass: git commit -m "feat(migration): [S001-idiomatic] <name> — idiomatic refactor: <idiom>"
  Evidence required: paste Phase 1 test command re-run (still green after refactor).
```

**Fan-out protocol (per wave):**

```bash
# Advisor spawns one coder per slice in the wave (in parallel):
for SLICE_ID in ${WAVE_SLICE_IDS[@]}; do
  BRIEF=$(generate_coder_brief "$SLICE_ID" "$OUTPUT_DIR/slice-plan.md" "$OUTPUT_DIR/slice-ledger.json")
  bin/summon --agent coder --brief "$BRIEF" --outbox "$OUTPUT_DIR/coders/$SLICE_ID/outbox.jsonl" &
  # Record session ID in ledger:
  update_ledger_coder_dispatched "$SLICE_ID" "$!"
done

# Advisor polls each coder outbox for result message:
for SLICE_ID in ${WAVE_SLICE_IDS[@]}; do
  bun "$ADV/lib/channel.js" tail --file "$OUTPUT_DIR/coders/$SLICE_ID/outbox.jsonl" \
    --after 0 --timeout 3600 --json
  # Parse result, update ledger
done
```

---

### Decision 3: Slice Granularity

**Option A — Fine-grained (1-3 files per slice):** maximum bisect isolation; very high slice count (200+ for large repos); orchestration overhead multiplies.
**Option B — Coarse-grained (1 behavior-coherent feature, 4-10 files):** lower count (30-80 typical); harder to bisect within a slice.
**Recommendation:** Option B. The migration worker must split any slice exceeding 5 files into sibling slices (S001a, S001b). Fine-grained slices used only for foundational data models and hub modules.

---

### Decision 4: Slice Ledger Persistence

**Option A — In-session JSON file (`$OUTPUT_DIR/slice-ledger.json`):** immediately readable; survives context compression; advisor reads/writes between waves.
**Option B — Git-based ledger (committed to new repo after each slice):** co-located with code; bisectable; couples orchestration to target repo.
**Recommendation:** Option A as primary; new repo git log as secondary audit trail.

---

## Pipeline Phases

### Phase 0: Pre-stage context (advisor, before summoning migration worker)

```bash
# Run before bin/summon --agent migration:
git -C "$SOURCE_REPO" log --reverse --format="%H %s" > "$WORKSPACE/commit_history.txt"
git -C "$SOURCE_REPO" log --reverse --format="%H %s" --name-status > "$WORKSPACE/commit_history_files.txt"
git -C "$SOURCE_REPO" ls-files > "$WORKSPACE/file_tree.txt"
gh pr list --repo "$SOURCE_REPO" --state merged --json title,body,number --limit 100 \
  > "$WORKSPACE/pr_context.json" 2>/dev/null || echo "[]" > "$WORKSPACE/pr_context.json"
```

The migration worker reads these files via Read tool, avoiding MCP git calls (which cost 4–32× more tokens).

---

### Phase 1: Migration Analysis

**Actor:** migration worker
**Input:** source_repo path, arch_def, epics, pre-staged workspace files
**Output:** `$OUTPUT_DIR/slice-plan.md`

1. Migration worker executes Steps 0–8 from `CLAUDE.md` (v2).
2. Advisor receives `result` with path to `slice-plan.md`.
3. Advisor reads `slice-plan.md`, extracts per-subsystem mode table and dead-code exclusions.
4. **GATE:** Advisor presents per-subsystem equivalence gate mode table to user and waits for confirmation. No dispatch until confirmed.
5. Advisor initializes the slice ledger (see Slice Ledger section).

---

### Phase 0.5: Mode-A Environment Setup (advisor-orchestrated, after Phase 1 gate)

**Actor:** advisor (with optional env-builder shell script)
**Trigger:** Only if at least one subsystem is tagged Mode A after user confirmation.
**Purpose:** Build/validate the old-system runnable environment and capture golden masters before ANY Mode-A coder workers are dispatched. Mode-B slices skip this phase entirely.

**Steps:**

1. **Identify Mode A subsystems** from the confirmed mode table in the slice ledger.

2. **Install dependencies and validate startup** for each Mode A subsystem:
   ```bash
   # Example for Python subsystem:
   cd "$SOURCE_REPO/<subsystem_path>"
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt 2>&1 | tail -5
   python main.py --help 2>&1 | head -3
   ```

3. **Capture golden masters** for all Mode A slices:
   ```bash
   for SLICE_ID in ${MODE_A_SLICE_IDS[@]}; do
     mkdir -p "$OUTPUT_DIR/golden"
     <old_entry_point> < "$INPUT_FIXTURES/$SLICE_ID_input.json" \
       > "$OUTPUT_DIR/golden/${SLICE_ID}_default.golden" 2>&1
     # Capture each scenario from equivalence_test_spec.scenarios
   done
   ```
   Golden files are stored at `$OUTPUT_DIR/golden/<slice_id>_<scenario>.golden`.
   Coder briefs for Mode A slices reference these golden files in their gate commands.

4. **Update ledger:** Mark each Mode A subsystem as `env_ready: true` and record golden file paths per slice.

**Cost estimate:** 30–90 minutes for a medium repo (10–50K LOC). Runs in one advisor session before any coder dispatch.

**Failure fallback — if env-build fails for a Mode A subsystem:**
- Log the failure in the ledger: `mode_fallback: "A→B"`, `env_build_error: <error output>`.
- Update all slices in that subsystem to `mode: "B"` and regenerate their equivalence_test_spec to use contract tests.
- Notify the user with the specific error and the Mode A → Mode B downgrade list.
- Do NOT block the entire pipeline; proceed with Mode B for the affected subsystem.

---

### Phase 2: Coder Fan-Out

**Actor:** advisor (using bin/summon --agent coder, N parallel calls)
**Input:** slice-plan.md (wave N slices), confirmed mode assignments, golden files (if Mode A), slice ledger
**Output:** coder workers make two atomic commits per slice to the new repo

For each wave:

1. Advisor reads all `planned` slices in the current wave from the slice ledger.

2. Advisor validates territory — no `target_location` overlaps in the wave:
   ```bash
   # Generate territory.md from wave slices, then validate:
   bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
     validate "$OUTPUT_DIR/territory-wave-${WAVE}.md"
   # Must exit 0 before dispatching
   ```

3. Advisor issues N parallel bin/summon --agent coder calls, one per slice. Each coder brief includes:
   - The slice definition (all fields from slice schema)
   - The new repo path
   - **Phase 1 instructions:** literal translation gate commands (cheap-first cascade), commit message format
   - **Phase 2 instructions:** idiomatic refactor gate commands (same equivalence tests), idiomatic verification command, commit message format
   - Explicit scope: "Edit ONLY files listed in `target_location`. Any edit to a file outside this list is an integrity violation."
   - Idiomatic mandate: "Phase 1: implement WITHOUT using the idiomatic pattern yet. Phase 2: refactor ONLY Phase 1 output — do not re-translate. You MUST use [idiomatic_note] in Phase 2. A no-idiom Phase 2 commit is a spec violation."
   - Golden file paths (Mode A) or contract test file paths (Mode B)

4. Advisor monitors each coder outbox for `result` messages. On result:
   - Parse `body.verdict`: `complete` | `partial` | `blocked`
   - Verify changes.md contains red+green evidence for BOTH commits
   - Update slice ledger status

---

### Phase 3: Per-Slice Equivalence Gate

**Actor:** advisor (verifying coder worker result)
**Input:** coder worker changes.md, equivalence_test_spec for the slice

The coder worker must produce in changes.md:
- **Commit 1 (literal) evidence:** failing test output (pre-implementation or pre-new-file) + passing test output (after literal implementation) — command + exit code for each.
- **Commit 2 (idiomatic) evidence:** same equivalence test re-run after idiomatic refactor — command + exit code.
- **Idiomatic verification:** grep/AST output confirming idiomatic pattern present in committed code.
- **Cheap-first cascade:** evidence that all 4–5 cascade steps ran in order (whitespace diff → AST parse → build → equivalence tests).

If the coder worker's verdict is `partial` or the equivalence gate fails:
- Advisor marks the slice as `failed_literal` (Commit 1 failed) or `failed_idiomatic` (Commit 2 failed) in the ledger.
- For `failed_literal`: advisor sends guidance (one retry) with the failure report.
- For `failed_idiomatic`: Commit 1 already exists in the new repo and is valid. Advisor can re-brief the coder with "Phase 2 only — Commit 1 SHA is [SHA], refactor from there."
- If still failing after one retry: pause the wave; do not advance to the next wave until failures are resolved.

---

### Phase 4: Atomic Commit and Bisect Hygiene

**Per-slice commit sequence in the new repo:**

```
Commit 1: feat(migration): [S001-literal] <name> — unidiomatic behavior-preserving translation
Commit 2: feat(migration): [S001-idiomatic] <name> — idiomatic refactor: <idiom>
```

Two commits per slice produces a linear history that supports two-level bisect:

```bash
# Level 1: which slice introduced the regression?
git bisect start
git bisect bad HEAD
git bisect good <commit before first literal commit>
git bisect run <equivalence_test_command>
# bisect identifies the slice (literal or idiomatic commit)

# Level 2: if the identified commit is a -literal: regression is in the translation
# If the identified commit is a -idiomatic: regression is in the idiomatic refactor
# → re-run coder for Phase 2 only, starting from the known-good -literal commit
```

**Bisect hygiene rules (coder brief enforces):**
1. No slice commit touches files outside its `target_location`.
2. The new repo compiles and all existing tests pass after every commit (both literal and idiomatic).
3. No fixup commits between slice commits; fixes are squashed before the commit is marked `committed`.
4. Linear history only; no merge commits between slices.
5. If Commit 2 (idiomatic) is reverted, Commit 1 (literal) must remain as a valid working state.

---

### Phase 5: Wave Completion and Ledger Update

After all slices in a wave have both commits verified:
1. Advisor updates all wave slices to `committed` in the ledger.
2. Post-wave consistency check:
   ```bash
   git -C "$NEW_REPO" log --oneline --since="<wave start ISO>"
   # Confirms: 2×N commits exist (N slices × 2 commits each), in order
   ```
3. Check for any `failed_literal` or `failed_idiomatic` slices. If any exist, next wave is blocked.
4. Advance to next wave; repeat Phase 2–5.

---

## Resumable Slice Ledger

The ledger is a JSON file at `$OUTPUT_DIR/slice-ledger.json`. The canonical implementation is at `lib/migration/ledger.js`.

### Ledger Schema (v2 — two-phase status enum)

```json
{
  "schema_version": 2,
  "migration_id": "<source_repo_name>-<YYYYMMDD>",
  "source_repo": "<absolute path>",
  "new_repo": "<absolute path>",
  "arch_def_path": "<path or 'inline'>",
  "subsystem_modes": [
    {
      "subsystem": "<name>",
      "entry_point": "<path>",
      "mode": "A",
      "mode_fallback": null,
      "env_ready": false,
      "env_build_error": null
    }
  ],
  "equivalence_gate_confirmed_by_user": false,
  "total_slices": 0,
  "waves": [
    {
      "wave_number": 1,
      "status": "planned",
      "slice_ids": ["S001", "S002"]
    }
  ],
  "slices": [
    {
      "slice_id": "S001",
      "name": "<name>",
      "wave": 1,
      "status": "planned",
      "depends_on": [],
      "target_location": ["<new repo file paths>"],
      "source_refs": ["<old repo file paths>", "<commit SHAs>"],
      "idiomatic_note": "<specific new-language feature or pattern>",
      "equivalence_test_spec": {
        "mode": "A",
        "literal_parity_approach": "golden-master-diff",
        "scenarios": ["<scenario names>"],
        "test_command": "<runnable command>",
        "golden_files": ["<paths in $OUTPUT_DIR/golden/>"],
        "literal_gate_passed": null,
        "idiomatic_gate_passed": null
      },
      "coder_sid": null,
      "commit_1_sha": null,
      "commit_2_sha": null,
      "failure_reason": null
    }
  ],
  "dead_code_excluded": [
    {
      "file": "<path>",
      "reason": "confirmed_dead",
      "disposition": "excluded"
    }
  ],
  "ts_started": "<ISO8601>",
  "ts_last_updated": "<ISO8601>",
  "current_wave": 1,
  "migration_complete": false
}
```

Valid slice status values: `planned` | `literal_dispatched` | `literal_committed` | `idiomatic_in_progress` | `committed` | `failed_literal` | `failed_idiomatic`

### Ledger Update Protocol

Use `lib/migration/ledger.js` for all ledger operations. For inline advisor scripts:

```bash
node -e "
  const { updateSlice } = require('$ADV/lib/migration/ledger.js');
  updateSlice('$OUTPUT_DIR/slice-ledger.json', 'S001', {
    status: 'literal_committed',
    commit_1_sha: '<sha>',
  });
"
```

Writes are atomic (write to `.tmp`, then `mv`) — `updateSlice` handles this internally.

### Ledger Resumption

```bash
node -e "
  const { resumeSummary } = require('$ADV/lib/migration/ledger.js');
  console.log(JSON.stringify(resumeSummary('$OUTPUT_DIR/slice-ledger.json'), null, 2));
"
```

**Key resume scenarios:**
- `literal_committed` slices: Commit 1 done but Commit 2 not yet started. Re-brief coder for idiomatic phase only.
- `failed_idiomatic` slices: Commit 1 is valid in the new repo. Re-brief coder for Commit 2 only, starting from `commit_1_sha`.
- `failed_literal` slices: No commits exist. Re-brief coder for full two-phase sequence.

---

## Territory Validation

Before each wave dispatch, validate that no `target_location` overlaps exist:

```bash
# Generate territory file from wave slices:
node -e "
  const { territoryTableForWave } = require('$ADV/lib/migration/ledger.js');
  const fs = require('fs');
  const table = territoryTableForWave('$OUTPUT_DIR/slice-ledger.json', parseInt(process.env.WAVE));
  fs.writeFileSync(process.env.OUTPUT_DIR + '/territory-wave-' + process.env.WAVE + '.md', table);
" WAVE=${CURRENT_WAVE}

# Validate — must exit 0 before dispatching:
bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
  validate "$OUTPUT_DIR/territory-wave-${CURRENT_WAVE}.md"
```

If `validate-territory.sh` exits non-zero, the migration worker must be re-invoked to split the conflicting slices.

After all coder workers in the wave have returned, run post-wave verification:

```bash
bash "$ADV/spawns/coder/.claude/skills/spawn-team/scripts/validate-territory.sh" \
  verify "$OUTPUT_DIR/territory-wave-${CURRENT_WAVE}.md" --repo "$NEW_REPO"
```

---

## Parallel Wave Execution

Two slices may execute in the same wave if and only if their `target_location` sets are disjoint. This applies to both commits of each slice — a slice's two commits happen sequentially within a single coder session; they do not interact with other slices in the same wave.

```
Wave 1: S001 [new/src/domain/user.ts]  ∩  S002 [new/src/domain/product.ts] = ∅  → parallel
Wave 2: S003 [new/src/app/user-service.ts]  — imports from S001 Commit 2 → must be wave 2+
```

The dependency on a preceding slice is specifically a dependency on its **Commit 2 (idiomatic)** being committed — the dependency slice must be fully complete (both commits) before dependent slices begin.

**Wave sizing constraint:** Each wave should contain no more than 8 slices. If a wave has more than 8 independent slices, split into sub-waves (2a, 2b) dispatched sequentially but internally parallel.

---

## Bug Isolation via Bisect

The two-commit-per-slice history enables two-level bisect-based regression isolation:

```bash
# Level 1: find which slice
git -C "$NEW_REPO" bisect start
git -C "$NEW_REPO" bisect bad HEAD
git -C "$NEW_REPO" bisect good <last known-good commit SHA>
git -C "$NEW_REPO" bisect run <equivalence_test_command>
# → identifies either a -literal or -idiomatic commit

# Level 2: if commit is -idiomatic, the literal is valid — re-run Phase 2 only:
git -C "$NEW_REPO" checkout <S001-literal-SHA>
# Re-brief coder: "Phase 2 only, starting from this SHA"

# Level 2: if commit is -literal, re-run full two-phase:
# Re-brief coder: "Full two-phase, starting from wave prerequisite SHA"
```

---

## Scale Considerations (Large Migrations)

| Repo size | Est. slices | Est. waves | Est. advisor sessions |
|---|---|---|---|
| Small (< 10K LOC) | 20-40 | 5-10 | 1-2 |
| Medium (10K-50K LOC) | 60-120 | 15-30 | 3-6 |
| Large (50K-200K LOC) | 150-300 | 40-75 | 8-15 |
| Very large (200K+ LOC) | 300+ | 75+ | 15+ |

Two commits per slice doubles the commit count relative to v1, but the ledger's `commit_1_sha`/`commit_2_sha` tracking makes recovery from partial failures cheaper — a failed idiomatic commit does not require re-running the literal translation.

---

## Key Invariants (v2)

1. **One slice = two atomic commits** in the new repo: one literal, one idiomatic. No exceptions.
2. **Literal gate before idiomatic.** Commit 2 is never attempted unless Commit 1 passes its equivalence gate. The literal translation is the behavior contract boundary.
3. **Per-subsystem mode, user-confirmed.** The advisor presents the mode table; no coder is dispatched without confirmation.
4. **Phase 0.5 before any Mode A dispatch.** Golden masters are captured before coders begin; coder briefs reference pre-captured files.
5. **Cheap-first cascade.** All gates run in order: whitespace diff → AST parse → build → equivalence tests. Fail fast.
6. **Dead code excluded before slicing.** Dead-code pre-pass results are in the ledger before any slice is created.
7. **Coder football team via direct summon.** The advisor issues N parallel bin/summon --agent coder calls; generic sub-teams teammates are not used for migration slices.
8. **Territory validated before dispatch.** validate-territory.sh runs before each wave; exits non-zero blocks dispatch.
9. **Ledger is the single source of truth.** Migration state is read from `slice-ledger.json`, not conversation history.
10. **Linear history for bisect.** Two commits per slice in strict order; no merge commits, no fixup commits.
