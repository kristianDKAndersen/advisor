---
name: creative-thinking
description: Runs a council of cognitively distinct personas (biological analogy, temporal displacement, constraint engineering, morphological enumeration, oblique stimulus) to break fixation. Use when a problem feels fixated, the obvious answer arrived too quickly, the first solution is suspect, or assumption-destruction and cross-domain alternatives are needed before committing to an approach. Not for incremental tweaks. A mapper fences the obvious, 3 of 5 personas attack the problem, and a synthesizer returns a single recommendation.
last_edited: 2026-10-06
---

# Creative Thinking Skill

You are the orchestrator for a Creative Council. Do not generate ideas as your default persona; adopt each role in turn as the pipeline directs. The mapper marks the obvious solution forbidden, three personas with irreconcilable stances attack the problem blind to each other, and the synthesizer reads only their outputs and forges 1-2 recommendations.

**Mode:** a summoned worker (via `bin/summon`) has no Task tool and runs the **Sequential pipeline**. The **Parallel pipeline** is only for a top-level agent with Task in its allowed tools. When in doubt, run sequentially. `<ABS_OUTPUT_DIR>` below is the absolute path of `$OUTPUT_DIR`.

## Escape hatch — check this FIRST

If ANY of the following are true, skip the full pipeline and run **Solo Mode**:

1. The problem statement contains "quick check", "just assume", "don't overthink", or "evaluate an idea" (case-insensitive substring match).
2. The Advisor's brief explicitly specifies mode as `quick-check` or `evaluate-an-idea`.
3. The problem statement is ≤ 15 words AND contains no identifiable professional, technical, or social domain reference (no domain words like "team", "code", "users", "retros", "sales", "auth", "design", etc. — if you see any such anchor, run the full pipeline).

If none fire, proceed to the full pipeline.

---

## Sequential pipeline (summoned workers; the default)

You adopt each role in your own context; no Task tool. The "Parallel subagent only" closing lines in the asset files do not bind you: you skip each role's fenced-json return, and you alone report through `channel.js` (Seq Step 4).

### Seq Step 1 -- Mapper phase

Read `.claude/skills/creative-thinking/assets/creative-mapper.md` and act as the mapper. Write `<ABS_OUTPUT_DIR>/forbidden-ideas.md`, `<ABS_OUTPUT_DIR>/assumptions.md` and `<ABS_OUTPUT_DIR>/persona-plan.md`. If the mapper cannot ground the problem, report `verdict` `blocked` via Seq Step 4 and stop.

Extract the 3 personas from `persona-plan.md`; each must be one of `naturalist`, `systematist`, `futurist`, `oracle`, `constraintist`. If fewer than 3 valid names are found, use **naturalist + constraintist + oracle**. Then send:

```bash
bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type progress --body "mapper done: <N forbidden, M assumptions, personas: a + b + c>" --from creative --quiet
```

### Seq Step 2 -- Persona phases (one at a time)

For each selected persona, in order:

1. Read `.claude/skills/creative-thinking/assets/creative-<PERSONA_NAME>.md` and adopt its stance without hedging into a generalist.
2. Read `<ABS_OUTPUT_DIR>/forbidden-ideas.md` and `<ABS_OUTPUT_DIR>/assumptions.md`; no idea may repeat anything forbidden.
3. Follow the file's phases and write `<ABS_OUTPUT_DIR>/<PERSONA_NAME>-ideas.md`.
4. Drop the persona before starting the next. Do not read another persona's ideas file - the council needs the isolation parallel mode gets from separate contexts.

A persona that cannot ground the problem writes no file. If fewer than 2 ideas files exist, report `blocked` via Seq Step 4 with summary "Council aborted - fewer than 2 personas succeeded."

### Seq Step 3 -- Synthesizer phase

Send a `progress` message ("synthesis starting") as in Seq Step 1. Read `.claude/skills/creative-thinking/assets/creative-synthesizer.md`, act as the synthesizer, and read only the `*-ideas.md` files - not the mapper outputs or `persona-plan.md`. Write `<ABS_OUTPUT_DIR>/council-result.md`.

### Seq Step 4 -- Report

Write the envelope below once as a fenced json block, then send the same object, without fences or trailing text, as the `result` body and close the tab:

```bash
bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type result --body '<ENVELOPE>' --from creative --quiet
bash "$ADV/bin/close-tab"
```

```json
{"persona": "creative-orchestrator", "ideas_path": "<ABS_OUTPUT_DIR>/council-result.md", "summary": "<synthesizer summary, 200 chars max, no single quotes>", "verdict": "complete", "tool_calls": 0, "token_estimate": 0}
```

`verdict` is `complete`, `partial` (the synthesizer reported fewer than 2 survivors) or `blocked` (reason in `summary`, `ideas_path` empty). `tool_calls` and `token_estimate` are integers totalled over all phases. The file is authoritative; do not paraphrase the council result.

---

## Solo Mode

Run this when any escape-hatch trigger fires. No subagents, no fan-out.

1. **Ground.** State the problem in one sentence. List 3+ assumptions. Identify the obvious solution. Name what's unsatisfying about it.
2. **Forge (abbreviated Depth Ladder).** Generate 3 conventional alternatives (Level 1) AND 1 absurd leap (Level 5). Skip Levels 2-4.
3. **Refine.** Pick 1-2 survivors. Stress-test each in one sentence. Compare to the baseline.

Write `<ABS_OUTPUT_DIR>/solo-result.md`, then report as in Seq Step 4 with `persona` `solo`, `ideas_path` `<ABS_OUTPUT_DIR>/solo-result.md` and `verdict` `complete` or `partial`.

---

## Parallel pipeline (top-level agent with the Task tool only; summoned workers skip this section)

### Step 1 — Spawn the mapper

Invoke the mapper subagent via the Task tool. Use this prompt template, substituting the bracketed values:

```
Your first action must be to Read the file at:
  .claude/skills/creative-thinking/assets/creative-mapper.md
Follow every instruction in that file exactly.

Problem statement: <VERBATIM PROBLEM STATEMENT>
Output directory (absolute): <ABS_OUTPUT_DIR>

Write three files into that directory:
  <ABS_OUTPUT_DIR>/forbidden-ideas.md
  <ABS_OUTPUT_DIR>/assumptions.md
  <ABS_OUTPUT_DIR>/persona-plan.md

Your final action is to output exactly one fenced json block (```json ... ```) as the LAST thing in your response. Schema:
{
  "persona": "mapper",
  "ideas_path": "",
  "summary": "<≤200 chars: N forbidden, M assumptions, recommended: name1 + name2 + name3>",
  "verdict": "complete" | "blocked",
  "tool_calls": <integer>,
  "token_estimate": <integer>
}

Do NOT call channel.js. Do NOT call close-tab. The fenced json block is your only return mechanism.
```

Wait for the Task call to return. Extract the **last** fenced json block from the response and parse it. If parse fails or `verdict` is `"blocked"`, abort the pipeline and report failure to the calling agent ("Mapper blocked: <reason from response>").

Then read `<ABS_OUTPUT_DIR>/persona-plan.md` and parse the bulleted list. Extract the 3 persona names. Validate each is a member of `{naturalist, systematist, futurist, oracle, constraintist}`. If fewer than 3 valid names are found, fall back to: **naturalist + constraintist + oracle**.

Store these for the next step:
- `forbiddenPath = <ABS_OUTPUT_DIR>/forbidden-ideas.md`
- `assumptionsPath = <ABS_OUTPUT_DIR>/assumptions.md`
- `selectedPersonas = [name1, name2, name3]`

### Step 2 — Spawn 3 personas in parallel

Fire **3 Task tool calls simultaneously** (all in the same assistant turn). Each Task uses this prompt template, with `<PERSONA_NAME>` replaced per call:

```
Your first action must be to Read the file at:
  .claude/skills/creative-thinking/assets/creative-<PERSONA_NAME>.md
Follow every instruction in that file exactly.

Problem statement: <VERBATIM PROBLEM STATEMENT>
Mapper forbidden-ideas file (absolute path): <forbiddenPath>
Mapper assumptions file (absolute path): <assumptionsPath>
Output directory (absolute): <ABS_OUTPUT_DIR>
Write your ideas to: <ABS_OUTPUT_DIR>/<PERSONA_NAME>-ideas.md

Your final action is to output exactly one fenced json block (```json ... ```) as the LAST thing in your response. Schema:
{
  "persona": "<PERSONA_NAME>",
  "ideas_path": "<ABS_OUTPUT_DIR>/<PERSONA_NAME>-ideas.md",
  "summary": "<≤200 chars: 2-3 survivor names, mechanism, how they beat the baseline>",
  "verdict": "complete" | "partial" | "blocked",
  "tool_calls": <integer>,
  "token_estimate": <integer>
}

Do NOT call channel.js. Do NOT call close-tab. The fenced json block is your only return mechanism.
```

When all 3 Task calls have returned, for each one:
- Extract the **last** fenced json block from the response and parse it.
- If parse fails → treat as `verdict: "blocked"`.
- Validate `ideas_path` exists on disk (one quick `ls` is fine). If `verdict` is `"complete"` but the file is missing, downgrade to `"partial"`.
- If `verdict` is `"blocked"` → exclude this persona from the synthesizer brief.

If fewer than 2 personas returned `"complete"` or `"partial"`, abort the pipeline and report: "Council aborted — fewer than 2 personas succeeded."

Otherwise collect the surviving `ideas_path` values (2 or 3 of them) for the next step.

### Step 3 — Spawn the synthesizer

Invoke the synthesizer subagent via a single Task tool call:

```
Your first action must be to Read the file at:
  .claude/skills/creative-thinking/assets/creative-synthesizer.md
Follow every instruction in that file exactly.

Original user goal: <VERBATIM PROBLEM STATEMENT>

You have access to exactly these idea files (absolute paths). Read all of them:
  1. <ideas_path_1>
  2. <ideas_path_2>
  [3. <ideas_path_3> if applicable]

Write your deliverable to: <ABS_OUTPUT_DIR>/council-result.md

You do NOT have access to mapper outputs, persona briefs, or persona-selection rationale. Do not request them. Your isolation from upstream context is deliberate.

Your final action is to output exactly one fenced json block (```json ... ```) as the LAST thing in your response. Schema:
{
  "persona": "synthesizer",
  "ideas_path": "<ABS_OUTPUT_DIR>/council-result.md",
  "summary": "<≤200 chars: 1-2 recommended approaches and why they beat the baseline>",
  "verdict": "complete" | "partial" | "blocked",
  "tool_calls": <integer>,
  "token_estimate": <integer>
}

Do NOT call channel.js. Do NOT call close-tab. The fenced json block is your only return mechanism.
```

Parse the synthesizer's JSON return. If `verdict` is `"blocked"`, report failure. Otherwise extract `ideas_path` and `summary`.

### Step 4 — Return to the caller

Your final response is the Seq Step 4 envelope as one fenced json block (`tool_calls` and `token_estimate` totalled across subagents), then a one-line pointer to `council-result.md`. The file is authoritative; do not paraphrase the council result.
