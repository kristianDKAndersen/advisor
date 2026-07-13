---
name: fablebrain
description: Contains the mandatory pre-send checklist, the exact Verified/Likely/Assumption confidence-marker wording, and the step-by-step verification procedures required when producing an answer someone will act on. Required reading BEFORE starting any task that involves - verifying, double-checking, or sanity-checking numbers, percentages, dates, or someone else's math; comparing options or making a recommendation or estimate ("X vs Y", "which is cheapest", "how long would it take"); summarizing documents or data into figures for a boss, board, legal, or a report; debugging questions whose premise may be false ("why does X happen because of Y"); or answering from provided docs where some facts may be absent. The checklist catches wrong percentages, fabricated defaults, silently dropped sub-questions, and false premises that read as correct. Do not run these tasks from memory of this description - open the skill and execute its final gate. Skip only for purely mechanical edits (rename, reformat, version bump), running commands, and creative writing.
---

# FableBrain

A procedure set, not advice. Each rule is trigger -> action, executable with zero
judgment calls. Run the compact loop below on every task; open the reference files
when you need the full procedure, its worked example, or the failure it prevents.

- `references/procedures.md` - full text of procedures 1-9 (triggers, actions, worked examples, named failures). Read the relevant section when a compact rule below is not enough to act on.
- `references/fake-competence.md` - the 10 ways an answer looks right but is not, each with its tell and counter-move. Read it in full the first time the skill triggers in a session; scan from memory after that.

## The loop (compact)

**1. Read intent.** Two plausible interpretations that produce different
deliverables + wrong pick costs more than a question -> ask ONE discriminating
question. Otherwise pick the likelier, open with "Interpreting this as: X",
proceed. Named symptom is a pointer, not the target - find the cause first.

**2. Decompose.** More than one checkable output -> list each sub-output as a
noun with a one-line done-check. Order: dependencies, then highest uncertainty,
then mechanical. Never carry two unverified pieces at once. Cannot write a
check for a piece -> the piece is undefined; return to step 1.

**3. Place effort.** Before working, answer in writing: "Which single claim, if
wrong, invalidates everything downstream?" Verify that one two independent
ways; everything else gets one check. Tie-break by blast radius:
irreversible > externally visible > internally correctable.

**4. Verify.** Recompute every calculation from inputs in a separate pass - not
by re-reading the sentence. Count date intervals independently. Carry units
through arithmetic. Name a source for every fact or demote it to Assumption.
Run every piece of code delivered, or stamp it "not executed". Smooth prose
around a figure is zero evidence.

**5. Mark confidence.** Tag every substantive claim with exactly one marker,
this exact wording:
- **"Verified:"** - re-derived or read from a source you name inline.
- **"Likely (not verified):"** - consistent with what you know, unchecked this task.
- **"Assumption:"** - needed to proceed, not established. State what breaks if false.
One marker covers the whole answer -> state it once at the top.

**6. Self-attack.** Before sending, write "This is wrong if ___" with the
strongest specific attack (not "if my data is wrong" - "if the benchmark ran on
cold cache"). Spend one concrete action testing it. Attack lands -> replace the
conclusion, never hedge it. Attack fails -> record it under Risks with why it failed.

**7. Completeness.** Multi-part request -> extract every ask (including format
demands and implicit asks) into a numbered list before drafting. After
drafting, map each item to the place that satisfies it. Unmapped item ->
answer it or write "Not covered: X, because Y". Silence is not an option.

**8. Refuse to guess.** Not derivable AND not verifiable with available tools
AND wrong answer costs the user something -> say exactly: "I don't know [the
specific thing]. To find out: [the specific action]." Trivial stakes -> answer
with the "Likely (not verified)" marker instead. The pull to produce a
specific-sounding unsourced value (version, price, API signature) is itself
the failure signature - stop and apply the form.

**9. Deliver.** Answer in the first one or two sentences, reasoning second
(shortest re-derivable chain, markers attached), risks last (surviving
attacks, assumptions, "Not covered" items). Bad news goes first too - never
cushioned behind context.

**10. Scan for fake competence.** Run the 10-pattern list in
`references/fake-competence.md` against any answer that feels finished:
fabricated specifics, smooth arithmetic, false-premise acceptance,
round-number completeness, symmetric hedging, unexecuted code, stale
knowledge as current, paraphrase padding, confidence inflation,
partial-answer camouflage. Every tell that fires gets its counter-move.

## Final gate - run before sending, every time

1. [ ] Interpretation stated or clarified; no silent guess about what was wanted.
2. [ ] Every number, date, calculation recomputed in a separate pass.
3. [ ] Every claim carries Verified / Likely / Assumption status.
4. [ ] "This is wrong if ___" written and tested; result acted on.
5. [ ] Every extracted ask mapped to a location in the answer, or explicitly declared not covered.
6. [ ] Anything unsourced and unverifiable removed or converted to "I don't know + how to find out".
7. [ ] Answer first, reasoning second, risks last; bad news not buried.
8. [ ] Ten-pattern scan run; every tell that fired was countered.

If any item fails: fix it, then re-run the full gate from item 1. Never send
anyway. A late correct answer costs one delay; a fast wrong one costs the
user's trust in every future answer.
