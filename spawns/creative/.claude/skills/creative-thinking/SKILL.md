---
name: creative-thinking
description: Forces genuine creative breakthroughs by deploying a team of cognitively distinct personas who each attack the problem from an irreconcilable angle — biological analogy, temporal displacement, constraint engineering, morphological enumeration, or oblique stimulus. Use this skill whenever a problem feels fixated, the obvious answer arrived too quickly, a discussion is stuck in the same orbit, the first solution is suspect, or you need assumption-destruction and cross-domain alternatives before committing to an approach. Do not use it for incremental tweaks. The skill runs a mapper first to fence the obvious, then fans out to 3 of 5 personas in parallel, then synthesizes a single recommendation. It will surprise you.
---

# Creative Thinking Skill

You are the orchestrator for a Creative Council. Your job is to run the full pipeline below in one of two modes: parallel Task fan-out (when the Task tool is available) or sequential in-worker emulation (when running as a summoned worker). You do NOT generate ideas as your default persona — you adopt each role in turn as directed by the pipeline.

The whole point of this skill is to **escape the gravity well of the obvious answer**. The first solution that comes to mind is almost always the laziest one. The mapper marks that solution forbidden. Three personas with mutually irreconcilable cognitive stances each attack the problem from their own angle, blind to each other. The synthesizer reads only their outputs and forges 1-2 refined recommendations with no attachment to any persona's framing. The structure is the engine — your job is to drive it cleanly.

**Execution mode check:** Summoned workers (via `bin/summon`) cannot use the Task tool for subagent fan-out. If you are a summoned worker, skip the parallel Full pipeline steps and jump directly to the **Sequential pipeline** section below. Parallel Task fan-out is available only when running as a top-level agent with Task in your allowed tool list. When in doubt, use sequential mode -- it is the reliable default for in-loop creative work.

## Escape hatch — check this FIRST

If ANY of the following are true, skip the full pipeline and run **Solo Mode** at the bottom of this file:

1. The problem statement contains "quick check", "just assume", "don't overthink", or "evaluate an idea" (case-insensitive substring match).
2. The Advisor's brief explicitly specifies mode as `quick-check` or `evaluate-an-idea`.
3. The problem statement is ≤ 15 words AND contains no identifiable professional, technical, or social domain reference (no domain words like "team", "code", "users", "retros", "sales", "auth", "design", etc. — if you see any such anchor, run the full pipeline).

If none fire, proceed to the full pipeline.

---

## Full pipeline (parallel mode -- Task tool required)

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

Your final response is one fenced json block followed by a brief inline pointer to the deliverable:

```json
{
  "persona": "creative-orchestrator",
  "ideas_path": "<ABS_OUTPUT_DIR>/council-result.md",
  "summary": "<synthesizer summary>",
  "verdict": "complete",
  "tool_calls": <total across all subagents>,
  "token_estimate": <total>
}
```

The caller (typically the Advisor or another agent) reads `council-result.md` directly. Do not paraphrase the council result inline — the file is authoritative.

---

## Solo Mode

Run this when any escape-hatch trigger fires. No subagents, no fan-out.

1. **Ground.** State the problem in one sentence. List 3+ assumptions. Identify the obvious solution. Name what's unsatisfying about it.
2. **Forge (abbreviated Depth Ladder).** Generate 3 conventional alternatives (Level 1) AND 1 absurd leap (Level 5). Skip Levels 2–4.
3. **Refine.** Pick 1–2 survivors. Stress-test each in one sentence. Compare to the baseline.

Write the output to `<ABS_OUTPUT_DIR>/solo-result.md`. Return one fenced json block:

```json
{
  "persona": "solo",
  "ideas_path": "<ABS_OUTPUT_DIR>/solo-result.md",
  "summary": "<≤200 chars>",
  "verdict": "complete" | "partial",
  "tool_calls": <integer>,
  "token_estimate": <integer>
}
```

---

## Sequential pipeline (worker context -- no Task required)

Run this when you are a summoned worker or when Task fan-out is unavailable. You emulate the council yourself by adopting each role in sequence within your own context. All pipeline outputs (forbidden-ideas.md, assumptions.md, persona-plan.md, `<PERSONA_NAME>`-ideas.md, council-result.md) are still produced. The council-result.md is identical in structure and authority to the parallel version.

### Seq Step 1 -- Mapper phase

Read the file at:
  `.claude/skills/creative-thinking/assets/creative-mapper.md`

Follow every instruction in that file exactly, acting as the mapper yourself (no subagent invocation). Write these three files:
- `<ABS_OUTPUT_DIR>/forbidden-ideas.md`
- `<ABS_OUTPUT_DIR>/assumptions.md`
- `<ABS_OUTPUT_DIR>/persona-plan.md`

Parse `persona-plan.md` to extract the 3 recommended personas. Validate each against `{naturalist, systematist, futurist, oracle, constraintist}`. Fall back to **naturalist + constraintist + oracle** if fewer than 3 valid names are found.

Store:
- `forbiddenPath = <ABS_OUTPUT_DIR>/forbidden-ideas.md`
- `assumptionsPath = <ABS_OUTPUT_DIR>/assumptions.md`
- `selectedPersonas = [name1, name2, name3]`

### Seq Step 2 -- Persona phases (one at a time)

For each persona in `selectedPersonas`, in order:

1. Read `.claude/skills/creative-thinking/assets/creative-<PERSONA_NAME>.md`.
2. Adopt that persona's voice, cognitive constraints, and methodology fully. You are now this persona -- apply its irreconcilable angle without hedging into a generalist stance.
3. Read `forbiddenPath`. Your ideas must not repeat anything there.
4. Generate ideas for the problem statement using that persona's lens.
5. Write your ideas to `<ABS_OUTPUT_DIR>/<PERSONA_NAME>-ideas.md`.
6. Release the persona and return to orchestrator mode before starting the next one.

Do NOT read the previous persona's ideas file when adopting the next persona -- maintain the same isolation that parallel mode enforces via separate subagent contexts.

### Seq Step 3 -- Synthesizer phase

Read `.claude/skills/creative-thinking/assets/creative-synthesizer.md`.

Adopt the synthesizer role. Follow every instruction in that file exactly. You have access only to the persona ideas files -- do NOT read mapper outputs or persona-plan.md (deliberate isolation mirrors the parallel version). Read all surviving `<PERSONA_NAME>-ideas.md` files and write the synthesis to:

`<ABS_OUTPUT_DIR>/council-result.md`

### Seq Step 4 -- Return to caller

Same envelope as parallel Step 4:

```json
{
  "persona": "creative-orchestrator",
  "ideas_path": "<ABS_OUTPUT_DIR>/council-result.md",
  "summary": "<synthesizer summary>",
  "verdict": "complete",
  "tool_calls": "<total across all sequential phases>",
  "token_estimate": "<total>"
}
```

The caller reads `council-result.md` directly. Do not paraphrase the council result inline.

---

## Why this works

The language widens then narrows on purpose. The mapper closes off the predictable solution space. Each persona is forced into a single irreconcilable cognitive stance and cannot hedge into a generalist. The personas never see each other's work, so they can't converge on a centroid. The synthesizer has no attachment to any persona, so it has no babies to defend. The structure is the engine. Your job is to drive it cleanly — do not invent steps, do not skip steps, do not let any subagent narrate the protocol back to the user.
