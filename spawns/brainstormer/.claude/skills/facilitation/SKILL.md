---
name: facilitation
description: Core facilitation mechanics for the brainstormer agent. Contains the 6-stage model with entry/exit criteria, facilitator scripts, idea ledger format, and stage-transition announcements. Load at session start.
allowed-tools: Read, Write, Bash
---

# Facilitation Skill

Read this file completely before facilitating. Do not skip sections.

**Reference files (load on demand):**
- `references/techniques.md` — 5 technique cards (brainwriting, SCAMPER, Six Thinking Hats, Lotus Blossom, Provocation). Read when a stage is stuck after 3 turns.
- `references/failure-modes.md` — 6 failure mode detection signals and counter-moves. Read when you detect drift or premature convergence.

---

## Idea Ledger Format

Maintain `$OUTPUT_DIR/ideas.md` throughout the session. Update at every stage transition.

```markdown
# Idea Ledger

| ID | Idea | Stage Captured | Maturity | Notes |
|----|------|---------------|----------|-------|
| I-01 | <one sentence> | Discover | captured | |
| I-02 | <one sentence> | Generate | expanded | built on I-01 |
| I-03 | <one sentence> | Generate | challenged | weak feasibility |
| I-04 | <one sentence> | Focus | parked | outside appetite |
| I-05 | <one sentence> | Decide | candidate | selected direction |
```

**Maturity values** (exactly 5 — no others):
- `captured` — recorded, not yet discussed
- `expanded` — developed at least one level deeper
- `challenged` — a specific assumption surfaced and named
- `parked` — explicitly deferred; NOT discarded; reason in Notes
- `candidate` — under active consideration for selected direction

**Rule:** Promote an idea from `captured` only when the participant (not you) has contributed to it.

---

## Stage 1: FRAME

**Mode:** Convergence on shared problem understanding
**Entry:** Any raw idea, brief, or direction — even vague.
**Exit artifact:** Problem statement (5 fields).

**Opening script:**
> "Stage 1: Frame. Goal: agree on the problem, not solve it. One question at a time."

**Elicitation (1 question per turn; wait for answer):**
1. "State the problem in one sentence without naming a solution."
2. "Who experiences this problem most acutely, and what are they trying to accomplish?"
3. "What does success look like 6–12 months out if this is solved well?"
4. "What is the appetite — how much time and scope is the team willing to invest?"
5. "Name at least 2 things that are explicitly out of scope."

**Exit artifact template:**
```
Job to be done: [solution-free]
Affected actor(s): [who]
Long-term goal: [success metric]
Appetite: [time/scope]
Out of scope: [≥2 items]
```

**Gate:** Read the statement back verbatim. Ask: "Does this represent what we are actually solving — not what we initially assumed?" Do not advance until confirmed.

**Transition:**
> "Stage 1 Frame complete. Advancing to Stage 2: Discover — divergence. No solutions yet."

---

## Stage 2: DISCOVER

**Mode:** Divergence on opportunities and unmet needs
**Entry:** Confirmed problem statement from Stage 1.
**Exit artifact:** Opportunity map, ≥5 distinct areas, each an unmet need (not a solution).

**Opening script:**
> "Stage 2: Discover. Pure divergence — we map problems, not solutions. I will redirect any solution framing."

**Elicitation:**
1. "Name all the friction points the affected actor experiences. We need at least 5."
2. "What do they currently do to work around this problem? What is broken about that?"
3. "Where does the most time, cost, or frustration concentrate?"
4. "What adjacent problems does this actor face that are not yet on our list?"
5. "What analogous friction exists in a completely different industry?"

**Anti-drift rule:** If a solution is proposed: "That sounds like a solution. What is the unmet need that would make it valuable? Name the problem first."

**Exit artifact template:**
```
- OPP-01: [unmet need]
- OPP-02: [unmet need]
- OPP-03: [unmet need]
- OPP-04: [unmet need]
- OPP-05: [unmet need]
```

Add each to `ideas.md` with maturity `captured`. Minimum 5 — continue elicitation if fewer.

**Gate:** Count areas. Read list back. Ask: "Are there opportunity areas missing before we narrow down?"

**Transition:**
> "Stage 2 Discover complete: [N] opportunities mapped. Advancing to Stage 3: Focus — first convergence step. Others are preserved as parked."

---

## Stage 3: FOCUS

**Mode:** Convergence on target opportunity
**Entry:** Opportunity map ≥5 areas from Stage 2.
**Exit artifact:** Target opportunity statement + ranked deferred list.

**Opening script:**
> "Stage 3: Focus. We select one opportunity to develop solutions for. I will ask you to evaluate on 3 criteria, then choose."

**Elicitation:**
1. "Rate each opportunity: strategic importance to our long-term goal — high, medium, or low."
2. "How many people experience this pain acutely — large group, moderate, or niche?"
3. "Which is most tractable within the appetite we named?"
4. "Which opportunity would you target, and why?"
5. "For each we set aside: why deferred, not abandoned?"

**Exit artifact template:**
```
Target: [unmet need]
Affected actor: [who]
Why selected: [≤2 sentences]
Deferred:
- OPP-XX: [name] — deferred because [reason]
```

Update `ideas.md`: set deferred to maturity `parked` with reason.

**Gate:** Read target statement back. Ask: "Is this the right focus? Comfortable setting the others aside?"

**Transition:**
> "Stage 3 Focus complete. Target: [target]. Advancing to Stage 4: Generate — second divergence. No evaluation until Stage 5."

---

## Stage 4: GENERATE

**Mode:** Divergence on solution concepts
**Entry:** Target opportunity from Stage 3 and appetite from Stage 1.
**Exit artifact:** ≥3 distinct solution concepts at sketch fidelity.

**Opening script:**
> "Stage 4: Generate. We need ≥3 distinct concepts for [target]. Distinct = different mechanism or different tradeoff. Sketch fidelity only — one sentence, key mechanism, one assumption. No evaluation. I will stop premature evaluation."

**Elicitation:**
1. "Concept 1: one sentence — what it does and how it works."
2. "Key mechanism for concept 1: the one thing that must be true for it to work."
3. "Concept 2: structurally different from concept 1 — not a variation."
4. "Concept 3: uses a different tradeoff or serves the user differently."
5. "Is there a concept that only works if we ignored one scope constraint? Name it — we can park it."

**Minimum quota:** Do not advance with fewer than 3 concepts. If stuck at 2, apply a technique from `references/techniques.md` (brainwriting prompt, SCAMPER pass, or Provocation).

**Anti-convergence rule:** If participant begins ranking during Stage 4: "Evaluation is Stage 5. What is concept [N]?"

**Exit artifact template:**
```
- C-01: [one sentence] | Mechanism: [key requirement] | Assumption: [key belief]
- C-02: [one sentence] | Mechanism: [key requirement] | Assumption: [key belief]
- C-03: [one sentence] | Mechanism: [key requirement] | Assumption: [key belief]
```

Add each to `ideas.md` with maturity `captured`.

**Gate:** Count concepts. Read each back. Ask: "Are these genuinely different, or are any variations? If variations, which to replace?"

**Transition:**
> "Stage 4 Generate complete: [N] concepts. Advancing to Stage 5: Decide — evaluation and assumption mapping."

---

## Stage 5: DECIDE

**Mode:** Convergence on direction and explicit assumption surfacing
**Entry:** ≥3 solution concepts from Stage 4.
**Exit artifact:** Direction (or ranked set) + assumption map + pitch summary.

**Opening script:**
> "Stage 5: Decide. Structured critique first, then direction selection. If we cannot choose one winner confidently, we will produce a ranked set — that is a valid outcome."

**Evaluation sequence:**
1. "Strongest argument FOR concept [X]? Name the specific value."  *(repeat for each concept)*
2. "Most dangerous risk in concept [X]? Be specific about the assumption that must hold."  *(repeat for each)*
3. "Which concept would you move forward with? Or, if you cannot choose: rank them and name what evidence would break the tie."
4. "Single most important assumption that must be true for this direction to succeed?"
5. "Top 3 assumptions ranked by importance × uncertainty (high importance + weak evidence = highest risk)."

**No-forced-convergence rule:** If the participant cannot select one winner: "We have a ranked set: [C-01 > C-02 > C-03]. Stage 6 designs the test to break the tie."

**Exit artifact template:**
```
Direction: [name] or "Ranked set: C-XX > C-YY > C-ZZ"
Rationale: [≤2 sentences]
Set aside: [other concepts and why]

Assumption map:
| Assumption | Importance | Evidence | Risk |
|------------|------------|----------|------|
| A-01       | High       | Weak     | HIGH |
| A-02       | High       | Medium   | MED  |
| A-03       | Medium     | Weak     | MED  |
Top 3 riskiest: A-01, A-02, A-03

Pitch:
  Problem: [from Stage 1]
  Appetite: [from Stage 1]
  Direction: [selected or ranked set]
  Rabbit holes: [top risks]
  No-gos: [Stage 1 out-of-scope + any discovered during session]
```

Update `ideas.md`: selected concept → `candidate`; rejected concepts → `parked` with reason.

**Gate:** Read the pitch summary back. Ask: "Does this accurately represent the decision?"

**Transition:**
> "Stage 5 Decide complete. Direction confirmed [or: ranked set confirmed]. Advancing to Stage 6: Validate — experiment design only, no evidence collection."

---

## Stage 6: VALIDATE

**Mode:** Focused convergence on experiment design
**Entry:** Assumption map with top 3 riskiest from Stage 5.
**Exit artifact:** 3 hypothesis statements + experiment cards.

**Opening script:**
> "Stage 6: Validate. For each of the 3 riskiest assumptions, we write a hypothesis and design the cheapest test. We design here — evidence collection happens outside this session."

**Elicitation (repeat for each of 3 assumptions):**
1. "Complete: 'We believe [A-0X] because [current evidence]. We'll know we're right when [measurable signal].'"
2. "Cheapest experiment: customer interview (opinion), fake door test (behavioral), or prototype test (strong)?"
3. "How many participants or data points would make the result convincing?"

**Exit artifact template:**
```
Hypothesis: "We believe [A-0X]. We'll test by [experiment]. We'll know we're right when [signal]."
Experiment card:
  Type: [interview / fake door / prototype]
  Participants: [N]
  Time cost: [estimate]
  Evidence strength: [opinion / behavioral / quantitative]
  Success criterion: [specific measurable threshold]
```

**Human gate statement:** "The experiment cards are ready. Whether to run them and whether evidence is sufficient to proceed to build requires organizational judgment. That decision is yours."

**Session close steps:**
1. Write `$OUTPUT_DIR/session.md` — full summary: stage outputs, pitch, assumption map, experiment cards.
2. Update `$OUTPUT_DIR/ideas.md` to final state.
3. Send result via channel.
4. Run `bash "$ADV/bin/close-tab"`.

---

## Stage Skipping Policy

- **Stage 1 (Frame):** Do not skip. Explain: "5 questions, 5 minutes. Without it, the session has no anchor."
- **Stage 2 (Discover):** Skip only if a pre-existing opportunity map meets the exit criteria (≥5 areas). Confirm by reading it back.
- **Stage 6 (Validate):** May be skipped if participant has existing evidence. Note in session.md.

---

## Single-Question Rule (Mandatory)

Ask exactly 1 question per turn during elicitation. Never combine questions.

- Correct: "What is the problem in one sentence, without naming a solution?"
- Incorrect: "What is the problem and who is affected and what does success look like?"

---

## Stuck Stage Protocol

If a stage has not produced its exit artifact minimum after 3 turns:

1. Read `references/techniques.md` and select the technique matching the stuck pattern.
2. Apply it and return to the stage elicitation.
3. If still stuck after the technique: log the gap in `session.md` and advance with what you have, noting the shortfall.
