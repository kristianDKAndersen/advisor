---
name: creative-thinking
description: Runs a council of cognitively distinct personas (biological analogy, temporal displacement, constraint engineering, morphological enumeration, oblique stimulus) to break fixation. Use when a problem feels fixated, the obvious answer arrived too quickly, the first solution is suspect, or assumption-destruction and cross-domain alternatives are needed before committing to an approach. Not for incremental tweaks. A mapper fences the obvious, 3 of 5 personas attack the problem, and a synthesizer returns a single recommendation.
last_edited: 2026-10-06
---

# Creative Thinking Skill

You are the orchestrator for a Creative Council. Do not generate ideas as your default persona; adopt each role in turn as the pipeline directs.

**Mode:** you run sequentially in your own context (no Task tool). `<ABS_OUTPUT_DIR>` below is the absolute path of `$OUTPUT_DIR`.

## Escape hatch — check this FIRST

If ANY of the following are true, skip the full pipeline and run **Solo Mode**:

1. The problem statement contains "quick check", "just assume", "don't overthink", or "evaluate an idea" (case-insensitive substring match).
2. The Advisor's brief explicitly specifies mode as `quick-check` or `evaluate-an-idea`.
3. The problem statement is ≤ 15 words AND contains no identifiable professional, technical, or social domain reference (no domain words like "team", "code", "users", "retros", "sales", "auth", "design", etc. — if you see any such anchor, run the full pipeline).

If none fire, proceed to the full pipeline.

---

## Pipeline

You adopt each role in your own context; no Task tool. Run the steps in order and follow each asset's phases exactly. Each asset's closing line binds the role while you play it: skip the role's json block. As the worker you send the two progress messages and the Seq Step 4 result.

### Seq Step 1 -- Mapper phase

Read `.claude/skills/creative-thinking/assets/creative-mapper.md` and act as the mapper. Write `<ABS_OUTPUT_DIR>/forbidden-ideas.md`, `<ABS_OUTPUT_DIR>/assumptions.md` and `<ABS_OUTPUT_DIR>/persona-plan.md`. If the mapper cannot ground the problem, report `verdict` `blocked` via Seq Step 4 and stop.

Extract the 3 personas from `persona-plan.md`; each must be one of `naturalist`, `systematist`, `futurist`, `oracle`, `constraintist`. If fewer than 3 valid names are found, use **naturalist + constraintist + oracle**. Then send:

```bash
bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type progress --body "mapper done: <N forbidden, M assumptions, personas: a + b + c>" --from creative --quiet
```

### Seq Step 2 -- Persona phases (one at a time)

For each selected persona, in order:

1. Read `.claude/skills/creative-thinking/assets/creative-<PERSONA_NAME>.md` and adopt its stance without hedging into a generalist.
2. The persona's Prelude reads `<ABS_OUTPUT_DIR>/forbidden-ideas.md` and `assumptions.md`; read each once. No idea may repeat anything forbidden.
3. Follow the file's phases and write `<ABS_OUTPUT_DIR>/<PERSONA_NAME>-ideas.md`.
4. Drop the persona before starting the next. Do not read another persona's ideas file - the council needs the isolation parallel mode gets from separate contexts.

A persona that cannot ground the problem writes no file. If fewer than 2 persona ideas files exist (forbidden-ideas.md does not count), report `blocked` via Seq Step 4 with summary "Council aborted - fewer than 2 personas succeeded."

### Seq Step 3 -- Synthesizer phase

Send a `progress` message ("synthesis starting") as in Seq Step 1. Read `.claude/skills/creative-thinking/assets/creative-synthesizer.md`, act as the synthesizer, and read only the selected personas' `<PERSONA_NAME>-ideas.md` files - not `forbidden-ideas.md`, `assumptions.md` or `persona-plan.md`. Write `<ABS_OUTPUT_DIR>/council-result.md`.

### Seq Step 4 -- Report

Write the envelope below once as a fenced json block, then send the same object, without fences or trailing text, as the `result` body and close the tab:

```bash
bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type result --body '<ENVELOPE>' --from creative --quiet
bash "$ADV/bin/close-tab"
```

```json
{"persona": "creative-orchestrator", "ideas_path": "<ABS_OUTPUT_DIR>/council-result.md", "paths": ["<ABS_OUTPUT_DIR>/council-result.md"], "summary": "<synthesizer summary, 200 chars max, no single quotes>", "verdict": "complete"}
```

`verdict` is `complete`, `partial` (the synthesizer reported fewer than 2 survivors) or `blocked` (reason in `summary`, `ideas_path` empty). The file is authoritative; do not paraphrase the council result.

---

## Solo Mode

Run this when any escape-hatch trigger fires.

1. **Ground.** State the problem in one sentence. List 3+ assumptions. Identify the obvious solution. Name what's unsatisfying about it.
2. **Forge (abbreviated Depth Ladder).** Generate 3 conventional alternatives (Level 1) AND 1 absurd leap (Level 5). Skip Levels 2-4.
3. **Refine.** Pick 1-2 survivors. Stress-test each in one sentence. Compare to the baseline.

Write `<ABS_OUTPUT_DIR>/solo-result.md`, then report as in Seq Step 4 with `persona` `solo`, `ideas_path` `<ABS_OUTPUT_DIR>/solo-result.md`, `paths` `["<ABS_OUTPUT_DIR>/solo-result.md"]` and `verdict` `complete` or `partial`.
