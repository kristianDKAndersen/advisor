---
name: migration
description: Migration planning procedure - pre-staged context, dead-code pre-pass, git-history intent recovery, concept map, two-phase slices, Mode A/B equivalence gates, slice-plan.md template. Use at the start of every migration planning session.
allowed-tools: Read, Bash, Grep, Glob, Write
last_edited: 2026-10-06
---

# Migration Planning Skill

The HOW for each workflow step. The worker's CLAUDE.md (principles, self-check gate, constraints) is the authority; where this file differs, CLAUDE.md wins.

Probes must not build, install, or write anything in the source repo; the graphify index (`graphify-out/`) is the only exception.

## Resources (load on demand)

Read a resource only when the step you are executing calls for it:

- **Pipeline architecture**: [resources/pipeline.md](resources/pipeline.md) (25KB) - how the advisor consumes your plan. Do not read it whole; Grep for the heading you need (`### Phase 0.5`, `## Resumable Slice Ledger`, `## Territory Validation`, `## Bug Isolation via Bisect`) and read only that section.
- **Idiom taxonomy**: [resources/idiom-taxonomy.md](resources/idiom-taxonomy.md) - source-to-target idiom mappings, idiomatic_note standard, Commit 2 linter anchors. Steps 5-6.
- **PHP-2016 patterns**: [resources/php-2016-idioms.md](resources/php-2016-idioms.md) - legacy PHP patterns with detection signals. Steps 3-6, PHP sources only.

## Step 0: Read project rules and pre-stage context

Do both in parallel before analyzing any code:

### 0.1 Read project rules

```bash
find "$SOURCE_REPO" -maxdepth 3 \( -name node_modules -o -name vendor \) -prune -o \( -name 'CLAUDE.md' -o -name 'REVIEW.md' -o -name 'ARCHITECTURE.md' \) -print | head -10
```

Read each found file. Record conventions, domain vocabulary, and documented migration constraints.

### 0.2 Read pre-staged context files

The advisor pre-staged `$WORKSPACE/commit_history.txt`, `commit_history_files.txt`, `file_tree.txt`, and `pr_context.json`. Check sizes with `wc -l` first. Read `file_tree.txt` and `pr_context.json` in full only when under ~2000 lines; otherwise Grep or Read ranges. Never Read `commit_history_files.txt` whole: Step 3 selects from it with Grep or ranges.

**If any file is absent**, stage it yourself:

```bash
git -C "$SOURCE_REPO" log --reverse --format="%H %s" > "$WORKSPACE/commit_history.txt"
git -C "$SOURCE_REPO" log --reverse --format="%H %s" --name-status > "$WORKSPACE/commit_history_files.txt"
git -C "$SOURCE_REPO" ls-files > "$WORKSPACE/file_tree.txt"
(cd "$SOURCE_REPO" && gh pr list --state merged --json title,body,number --limit 100) \
  > "$WORKSPACE/pr_context.json" 2>/dev/null || echo "[]" > "$WORKSPACE/pr_context.json"
```

Never bulk-read git history via MCP tools (4-32x the token cost of the CLI).

## Step 0.5: Dead-code pre-pass (MANDATORY before slicing)

Migrating dead code costs full verification for zero business value, so identify and exclude it before slicing.

### Dead-code detection

Build the graph index once, from the source repo root. Do not run `lib/graphify-setup.sh` (it indexes the current directory and installs a git hook in it):

```bash
(cd "$SOURCE_REPO" && "$ADV/bin/capture" graphify update . --no-cluster)
```

**Language-specific static analysis (run first; faster than symbol-by-symbol graphify):**

```bash
# Python - unused code with >= 80% confidence:
python3 -m vulture "$SOURCE_REPO" --min-confidence 80 2>/dev/null | head -50 || true

# TypeScript/JavaScript:
(cd "$SOURCE_REPO" && npx --yes ts-prune --project tsconfig.json 2>/dev/null | head -50) || true

# Go:
(cd "$SOURCE_REPO" && deadcode ./... 2>/dev/null | head -50) || true

# Rust - unused deps and dead_code warnings (build output kept outside the repo):
(cd "$SOURCE_REPO" && CARGO_TARGET_DIR="$WORKSPACE/cargo-target" cargo +nightly udeps 2>/dev/null | head -20) || true
(cd "$SOURCE_REPO" && CARGO_TARGET_DIR="$WORKSPACE/cargo-target" cargo check --locked 2>&1 | grep -E 'never (used|constructed|read)' | head -20) || true

# PHP - composer-based projects:
(cd "$SOURCE_REPO" && vendor/bin/phpstan analyse --level 0 . 2>/dev/null | head -50) || true
# Pre-composer 2016-era PHP usually has no static-analysis harness: use grep-based
# include/require tracing plus graphify (see resources/php-2016-idioms.md).
```

**Per-exported-symbol reverse traversal (graphify):** an exported symbol with an empty importer/affected set is dead. Use it to confirm candidates from the tools above and to find dead code they miss (exported symbols with no cross-module callers):

```bash
graphify affected "<symbol>" --graph "$SOURCE_REPO/graphify-out/graph.json"   # batch candidates in one shell loop rather than one call each
# Empty result = no importers = symbol is dead
```

### Dead-code decision protocol

For each dead-code candidate found:
1. **Verify unreachability**: Cross-reference with epics' out-of-scope list. If epics explicitly exclude a behavior, its code is confirmed dead.
2. **Check git recency**: If the last commit touching the file is >12 months old AND no epic references the behavior, classify as dead.
3. **Record in slice plan header**: List all excluded files with classification (`confirmed_dead` | `out_of_scope_per_epics` | `deferred_to_user`).
4. **Do NOT create migration slices for confirmed dead code.** The advisor may optionally create a separate cleanup task.

## Step 1: Parse and validate inputs

### 1.1 source_repo

Confirm the source_repo path is a git repository and count commits from the pre-staged file (do not Read it):

```bash
git -C "$SOURCE_REPO" rev-parse --git-dir
wc -l < "$WORKSPACE/commit_history.txt"
```

Record the commit count; it sets the depth of the Step 3 history walk.

### 1.2 arch_def

Parse arch_def in whatever format it arrives (Markdown, HTML export, Miro/JSON, YAML).

Extract from arch_def:
1. Target language(s) and runtime(s)
2. Module/package structure (directory layout)
3. Architectural layers and their rules (what each layer may import)
4. Named domain entities and their canonical locations in the new structure
5. Integration points (external APIs, databases, message queues)

### 1.3 epics

Parse epics to extract:
1. Named behaviors that MUST be preserved in the migration
2. Acceptance criteria framed as observable outputs
3. Out-of-scope behaviors (features intentionally dropped — feed back to dead-code classification in Step 0.5)
4. Performance, security, or compliance constraints affecting equivalence testing

## Step 2: Pre-index source repo with graphify

The index was built in Step 0.5; do not rebuild it.

**Fallback ladder** (when graphify is unavailable or `graphify-out/graph.json` is absent):
1. `aider --show-repo-map`
2. `ctags -R --fields=+n .`
3. `grep` import map

The graph shows structure only; read hotspot files (Step 4) for intra-function logic.

### 2.1 Slice bounding on the OLD/source repo

All take `--graph "$SOURCE_REPO/graphify-out/graph.json"`: `graphify affected <symbol>` (blast radius), `path <moduleA> <moduleB>` (dependency path), `explain <symbol>` (typed edges), `get_neighbors <node>`.

Identify:
- **Tightly coupled clusters** (high incoming + outgoing edges) — migrate as a single slice; splitting produces non-compiling intermediates.
- **Leaf modules** (few or no dependents) — ideal starting slices; low blast-radius.
- **Hub modules** (high fan-in) — migrate last.

### 2.2 Optional per-slice check on the GROWING new repo (coder spec only; do not run)

Once coder workers begin implementing slices:

```bash
graphify update "$NEW_REPO" --no-cluster
graphify affected <newly_added_symbol> --graph "$NEW_REPO/graphify-out/graph.json"
```

Include this in the per-slice verification spec for dead-export detection.

## Step 3: Walk full git history commit-by-commit

Select from `$WORKSPACE/commit_history_files.txt` with Grep or Read ranges, never whole. For large repos (>1000 commits), apply the token-budget selection heuristic:
1. The 20 most recent merges to main/master.
2. The first 10 commits (foundational data models).
3. All commits touching files identified as hubs by graphify.
4. All commits in the 90-day window before the migration decision.

Stage commit messages in one call, not one call per commit (file lists are already in `commit_history_files.txt`):

```bash
git -C "$SOURCE_REPO" log --reverse --format='%H %s%n%b' > "$WORKSPACE/commit_bodies.txt"             # all commits (<=1000)
git -C "$SOURCE_REPO" log --no-walk --format='%H %s%n%b' <SHA>... > "$WORKSPACE/commit_bodies.txt" # selected commits (>1000)
```

Grep or Read ranges of `commit_bodies.txt`; never Read it whole. Read a diff (`git -C "$SOURCE_REPO" show <SHA> -- <file>`) only for hub or high-churn files whose message does not explain the intent.

**Extract:** when each behavior appeared; refactor signals (renames, moves, splits); bug-fix clusters (fragile invariants, test thoroughly); deletions (intentionally dropped, cross-check epics out-of-scope); co-change coupling (natural slice boundaries).

Record the behavioral map as: `{feature_name, introduced_commit, stabilized_commit, files, intent_summary}`.

## Step 4: Behavioral hotspot prioritization

```bash
git -C "$SOURCE_REPO" log --format="" --name-only | grep -vE '(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|go\.sum|poetry\.lock|CHANGELOG[^/]*)$|(^|/)(vendor|node_modules|dist|build)/' | sort | uniq -c | sort -rn | head -40
```

Classify files:
- **HIGH-CHURN (>20 commits):** Core business logic; most thorough equivalence testing required.
- **LOW-CHURN (<5 commits):** Stable utilities; candidates for mechanical translation.

Read the top 10 highest-churn files in full when under 30KB; for larger ones, Grep key symbols and Read only those ranges.

## Step 5: Map old concepts to new architecture

Produce a concept map:

| Old module/concept | Old location (files) | New location (per arch_def) | Layer | Cardinality | Idiomatic note |
|---|---|---|---|---|---|
| [concept] | [file paths] | [new package/module path] | [domain/app/infra/...] | 1:1 / 1:N / N:1 / dropped | [idiom] |

For each mapping, record:
1. Whether the concept maps 1:1 (rename), 1:many (split), many:1 (merge), or is dropped (per epics).
2. Whether the new location requires a language idiom not present in the old code.
3. The blast-radius score from graphify (HIGH/MED/LOW).

**Idiomatic rewrite mandate:** Every slice MUST include an idiomatic_note naming at least one specific new-language feature or architectural pattern. A slice without a non-trivial idiomatic note is a plan failure. Consult [resources/idiom-taxonomy.md](resources/idiom-taxonomy.md) for source-pattern → target-idiom mappings per language, and [resources/php-2016-idioms.md](resources/php-2016-idioms.md) when the source repo is legacy PHP.

## Step 6: Derive ordered slice plan

Ordering rules:
1. **Foundational data models and domain entities first** — no local dependencies.
2. **Leaf modules second** — low blast-radius, independently verifiable.
3. **Business logic slices in dependency order** — use graphify path queries.
4. **Integration and adapter slices** — external API clients, database adapters.
5. **Hub modules last** — high fan-in.
6. **Entry points and composition root last** — main, index, app bootstrap.

### Slice definition (two-phase schema)

Each slice MUST carry:

| Field | Description |
|---|---|
| `slice_id` | Stable identifier: `S001`, `S002`, ... (never renumber) |
| `name` | Human-readable behavior-coherent name |
| `description` | One sentence: what behavior this slice implements |
| `source_refs` | Old files and commit SHAs this slice derives from |
| `target_location` | New repo package/module path(s) per arch_def |
| `layer` | Architectural layer (domain, application, infrastructure, presentation, ...) |
| `idiomatic_note` | Specific new-language feature or pattern this slice MUST use in Commit 2 |
| `dependencies` | Slice IDs this slice depends on (must be both commits committed first) |
| `wave` | Parallel wave number (same-wave slices have disjoint `target_location`) |
| `equivalence_test_spec` | See Step 7; mode is per-SUBSYSTEM |
| `blast_radius` | graphify score or estimate; HIGH/MED/LOW |
| `commit_1_literal` | Commit message and gate criteria for the literal/unidiomatic commit |
| `commit_2_idiomatic` | Commit message and gate criteria for the idiomatic refactor commit |

**commit_1_literal schema:**
```
message: "feat(migration): [S001-literal] <name> — unidiomatic behavior-preserving translation"
gate: equivalence_test_spec passes; new repo compiles; no tests regress
```

**commit_2_idiomatic schema:**
```
message: "feat(migration): [S001-idiomatic] <name> — idiomatic refactor: <idiomatic_note>"
gate: SAME equivalence tests still pass (identical test command, must exit 0); idiomatic_note verified present in code
```

**Wave assignment:** Two slices may be in the same wave only if their `target_location` sets are disjoint. Both commits (literal + idiomatic) for a slice belong to the same wave. A slice's wave-N dependency means its Commit 2 (idiomatic) must be committed before any wave-N+1 slice begins.

## Step 7: Equivalence test specification (dual-mode, per-SUBSYSTEM)

### 7.1 Per-subsystem mode detection

Mode is detected PER SUBSYSTEM, not per whole repo. A repo may have Mode A subsystems (runnable) and Mode B subsystems (not runnable). Each slice is tagged with its subsystem's mode.

**Subsystem boundary:** A subsystem is a set of files startable in isolation (CLI entry point, pure computation module, daemon with mock config): find runnable entry points whose dependencies resolve.

**Detection sequence (run per subsystem entry point):**

```bash
# Step 1: Find entry points
find "$SOURCE_REPO" -maxdepth 3 \( -name 'package.json' -o -name 'Makefile' -o -name 'pyproject.toml' -o -name 'Cargo.toml' -o -name 'go.mod' -o -name 'composer.json' -o -name 'index.php' \) | head -10

# Step 2: Attempt dry-run for each candidate entry point
node "$SOURCE_REPO/index.js" --help 2>&1 | head -5
python "$SOURCE_REPO/main.py" --help 2>&1 | head -5
php -l "$SOURCE_REPO/index.php" 2>&1 | head -5
# etc.
```

- If a runnable entry point exists AND dry-run exits without errors: **Mode A (RUNNABLE)** for that subsystem.
- Otherwise: **Mode B (NOT RUNNABLE)** for that subsystem.

Record mode per subsystem in the slice plan. Each slice's `equivalence_test_spec.mode` is set to the mode of its subsystem. The advisor confirms the per-subsystem mode assignment with the user before dispatching coder workers.

### 7.2 Mode A — Old system subsystem is RUNNABLE

**Phase 0.5 prerequisite:** the advisor captures golden masters for this subsystem before any Mode A slice is dispatched (you do not capture them). Coder briefs reference the pre-captured files:
```bash
<old_entry_point> < input_fixture > "$OUTPUT_DIR/golden/<slice_id>_<scenario>.golden"
```

**Literal-boundary parity check (Commit 1 gate):**
The equivalence test must pass at the literal translation boundary, before idiomatic refactoring. Because the target language is different from the source language, parity is verified via one of these approaches (select based on language pair):

| Approach | When to use | How |
|---|---|---|
| **Golden-master file comparison** | Any language pair; old and new executables produce file output | Run `<new_literal_entry_point>` with same inputs; `diff <golden_file> <actual_output>` |
| **FFI bridge testing** | C/C++ source → Rust target | Compile both, invoke via FFI test harness, compare outputs/side effects per-function |
| **Contract test suite** | When golden outputs contain non-deterministic fields (UUIDs, timestamps) | Write assertions that mask non-deterministic fields; use `jq`-based comparators or approval-tests |

Set `equivalence_test_spec.literal_parity_approach` per Mode A slice to exactly one of `golden-master-diff`, `ffi-bridge`, `contract-with-masking` (in table order).

Gate: the 7.4 cascade, step 4 = golden `diff` (or FFI harness) exit 0 per file; Commit 2 re-runs it unchanged and verifies `idiomatic_note` by grep or AST check.

### 7.3 Mode B — Old system subsystem is NOT RUNNABLE

Contract / intent tests derived from: (a) arch_def's named behaviors, (b) epics' acceptance criteria, (c) existing test files in source repo (even non-runnable, their assertions encode the contract), (d) commit messages describing expected behavior.

Each test case must have: (a) a named scenario, (b) the input state, (c) the expected output or side effect, (d) the arch_def or epic section that justifies this expectation.

Gate: as Mode A, with step 4 = this slice's contract tests.

### 7.4 Per-slice gate: cheap-first verification cascade

Both modes use this ordered gate. Check cheapest first — fail fast before reaching expensive steps:

```
1. Whitespace-only diff filter
   └─ cmd: git add -N <file> && git diff --ignore-all-space --exit-code -- <file>
   └─ purpose: detect no-op LLM outputs before spending build tokens
   └─ pass: exit 1 (real changes present); fail: exit 0 (no translation happened)

2. AST parse validation
   └─ cmd (TS): node --check <file>
   └─ cmd (Python): python3 -m py_compile <file>
   └─ cmd (Rust): rustc --edition 2021 --crate-type lib <file> --emit=metadata
   └─ cmd (Go): go build ./...
   └─ purpose: syntax is valid before running tests
   └─ fail: parse error → abort, do not proceed

3. Build verification (compilation)
   └─ cmd: <language-appropriate build command> for the new repo
   └─ purpose: all imports resolved, types check
   └─ fail: build error → abort

4. Equivalence tests (Mode A: golden diff; Mode B: contract tests)
   └─ cmd: <equivalence_test_spec.test_command>
   └─ purpose: behavior parity confirmed
   └─ fail: test failure → slice is failed; bisect from here

5. New repo graphify check (optional, recommended for HIGH blast-radius slices)
   └─ cmd: graphify affected <new_slice_symbol> --graph "$NEW_REPO/graphify-out/graph.json"
   └─ purpose: no dead exports, no unexpected coupling
```

The coder brief must instruct workers to run this cascade in order and stop at the first failure, reporting which step failed and its full output.

## Step 8: Output format

Write the plan to `$OUTPUT_DIR/slice-plan.md`.

```markdown
## Migration Slice Plan: [source_repo name] → [target description]

### Dead-Code Exclusions
| File/Symbol | Reason | Last changed | Disposition |
|---|---|---|---|
| [file] | confirmed_dead / out_of_scope_per_epics / deferred_to_user | [date/commit] | excluded / deleted |

### Synthesis
**Stated** (from inputs): ...
**Inferred** (un-validated bets): ...
**Out-of-scope** (per epics): ...

### Source Repo Summary
- Total commits: [N]
- Files analyzed: [N]
- High-churn files (>20 commits): [list]
- Dead-code excluded: [N files]
- graphify index: present | fallback used ([which fallback])

### Per-Subsystem Equivalence Gate Modes
| Subsystem | Entry point | Mode | Evidence | Fallback triggered? |
|---|---|---|---|---|
| [subsystem] | [entry point] | A | [dry-run output] | no |

**[GATE — requires user confirmation before coder dispatch]**

### Concept Map
| Old module/concept | Old location | New location | Layer | Cardinality | Idiomatic note |
|---|---|---|---|---|---|
| [concept] | [files] | [new path] | [layer] | [1:1/1:N/...] | [idiom] |

### Ordered Slice Plan

| Slice ID | Name | Wave | Depends on | Source refs | Target location | Idiomatic note | Blast radius | Mode | Literal parity approach |
|---|---|---|---|---|---|---|---|---|---|
| S001 | [name] | 1 | - | [files/commits] | [new path] | [idiom] | LOW | A | golden-master-diff |
| S002 | [name] | 1 | - | [files/commits] | [new path] | [idiom] | LOW | B | n/a (Mode B) |

### Per-Slice Equivalence Test Specs

#### S001 — [name] (Mode A)
**Commit 1 (literal) gate:**
- Literal parity approach: golden-master-diff
- Scenarios: [list]
- Inputs: [fixture paths]
- Expected outputs: [golden file refs]
- Gate command (all five cascade steps of 7.4, in order, stop at first failure):
  1. `git add -N <file> && git diff --ignore-all-space --exit-code -- <file>` - exit 1 (changes present)
  2. `<parse command>` - exit 0
  3. `<build command>` - exit 0
  4. `diff $OUTPUT_DIR/golden/S001_<scenario>.golden <actual>` - exit 0 for all scenarios
  5. `graphify affected <new_slice_symbol> --graph "$NEW_REPO/graphify-out/graph.json"` - no dead exports (optional; recommended for HIGH blast-radius)
- Commit message: `feat(migration): [S001-literal] <name> — unidiomatic behavior-preserving translation`

**Commit 2 (idiomatic) gate:**
- Gate command: the same five-step cascade as Commit 1, with the same expected exit codes
- Idiomatic verification: `grep -r '<idiomatic_pattern>' <target_location>` — must match
- Commit message: `feat(migration): [S001-idiomatic] <name> — idiomatic refactor: <idiom>`

[repeat for each slice]

### Architecture Decisions

[Per decision: question, options weighed for THIS repo, recommendation. Always include Decision 1: per-subsystem mode (user confirms before dispatch). Defaults: mixed mode A/B; one behavior-coherent unit per slice, split above 5 files; new-repo graphify after every commit for HIGH blast-radius, per wave for leaf modules.]

### Dependency Graph
- Wave 1 (parallel): [slice IDs with disjoint target_location]
- Wave 2 (parallel): [slice IDs depending on Wave 1 Commit 2 being committed]
- Sequential dependencies: [S_n must precede S_m because ...]
- Blocked on external: [any slice blocked by external dep not in scope]

### Spikes (unknowns)
- [Question]: time-box N hours. Exit: [what counts as answered] / [what counts as not answered]

### Re-evaluation triggers
- If a subsystem dry-run that worked during planning fails during Phase 0.5: re-tag affected slices as Mode B and update their equivalence_test_specs.
- If arch_def is updated mid-migration: re-run Steps 5-6 for affected slices.
- If a coder worker's Commit 1 fails the literal gate: pause the wave; diagnose whether the spec was wrong or the implementation was wrong before resuming.
- If a coder worker's Commit 2 fails the idiomatic gate but Commit 1 passed: the regression is in the idiomatic refactor; the literal commit can stand; re-brief the coder for Commit 2 only.
```

Run the CLAUDE.md self-check gate (8 checks) on the draft BEFORE writing `slice-plan.md`, fix every failure, then write it. The result summary repeats each subsystem's chosen mode, flagged for Advisor confirmation.
