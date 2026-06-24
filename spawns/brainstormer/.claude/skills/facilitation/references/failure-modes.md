# Brainstorming Failure Modes

Reference file. Load when you detect a session pattern that matches a detection signal below. Apply the counter-move for that mode.

Each entry: failure mode name, definition, detection signal, counter-move.

---

## 1. Production Blocking

**Definition:** Sequential turn-taking causes participants to spend the majority of time listening or waiting rather than generating. Ideas are lost while waiting for the turn. In verbal group settings, roughly 80% of time is listening time (Diehl and Stroebe 1987, 4 controlled experiments).

**Detection signals:**
- Participant says "I lost my idea while you were talking."
- Response time before answering is long; answers are short.
- Concept list is growing slowly despite participant engagement.
- Participant is generating ideas that only extend the immediately prior idea.

**Counter-move:**

1. Switch to brainwriting format immediately (see `techniques.md`, Technique 1).
2. Ask the participant to write 3 ideas without verbal exchange before responding.
3. Collect all 3 ideas before providing any response or acknowledgment.
4. Do not interject between the prompt and the written output.

**Why it works:** Simultaneous written generation eliminates the turn-taking channel. No waiting, no production blocking. This is the mechanism with the strongest empirical backing in the research base.

---

## 2. Anchoring

**Definition:** The first idea shared sets a cognitive reference point. Subsequent ideas cluster around it rather than diverging. Even when participants intend to generate independent ideas, they unconsciously adjust their proposals toward the anchor.

**Detection signals:**
- Concepts in Stage 4 all share the same core mechanism as the first concept proposed.
- Participant keeps returning to the first idea as a frame of reference ("like I said before, but also...").
- Opportunity areas in Stage 2 all describe variations on one dimension of the problem.
- Evaluations in Stage 5 consistently favor the concept that was stated first.

**Counter-move:**

1. Name the anchor explicitly: "I notice that our concepts have all used [shared mechanism]. Let us explicitly set that aside for this next generation pass."
2. Run a Provocation pass (see `techniques.md`, Technique 5) targeting the anchored assumption: "Po: the solution cannot use [anchored mechanism]. What would you do instead?"
3. For Stage 2 anchoring: run a Lotus Blossom expansion (see `techniques.md`, Technique 4) to force coverage of dimensions beyond the anchored one.
4. Require independent generation before group exposure: "Before I respond, give me your next concept without reference to anything we have already discussed."

---

## 3. Groupthink

**Definition:** Conformity pressure suppresses dissent. Participants agree with the dominant framing even when they privately hold a different view. False consensus forms. In the brainstorming context, groupthink produces idea lists that all reflect one perspective.

**Note on evidence:** The anti-groupthink claims for most structured techniques are design-intent only. No controlled experiment has measured groupthink reduction in ideation groups specifically. The counter-moves below are structurally sound but treat their effectiveness as an untested claim.

**Detection signals:**
- Every evaluation in Stage 5 agrees — no one has named a risk or weakness.
- All opportunities in Stage 2 come from the same user perspective.
- The participant uses phrases like "as we agreed" or "obviously" without prior explicit agreement.
- Challenging questions receive no pushback.

**Counter-move:**

1. Run the Black Hat rotation explicitly (see `techniques.md`, Technique 3): "We have been in Yellow Hat. Let us switch to Black Hat. Every weakness and risk — bring it now. This is the designated space for criticism."
2. Introduce explicit devil's advocate role: "For the next 2 turns, argue against the dominant direction. What is the strongest case that it is wrong?"
3. Ask for the suppressed concern: "Is there anything you are holding back because it feels obvious or awkward to say? Name it."
4. Run a divergent pass that requires a structurally different direction: "Give me a concept that would succeed by doing the exact opposite of what we have been assuming."

---

## 4. HiPPO Effect (Highest Paid Person's Opinion)

**Definition:** Status-based idea dominance. In group settings, senior voices disproportionately anchor the group even under nominal "no-criticism" rules. Ideas from high-status participants are evaluated more favorably and are harder to challenge.

**In AI-facilitated solo sessions:** HiPPO manifests as the participant deferring to their own senior stakeholder's framing ("My CEO thinks we should...") rather than exploring independently.

**Detection signals:**
- Participant prefaces ideas with authority attribution: "My VP said..." or "The CEO wants..."
- Ideas attributed to senior stakeholders are not questioned, while other ideas are scrutinized.
- The participant frames the task as "how do we justify what [authority figure] has already decided?"
- Stage 1 problem statement is framed as a solution disguised as a problem.

**Counter-move:**

1. Decouple the attributed idea from the authority: "Set aside who proposed it for a moment. What is the underlying problem that idea is trying to solve? Name the problem, not the solution."
2. Run anonymous evaluation: "Rate each concept on [criterion] as if you did not know who proposed it. What rating does each receive?"
3. Reframe the session goal: "Our goal is to find the best solution to the problem we named in Stage 1, not to validate a direction that has already been chosen. Are those the same thing, or different?"
4. If the participant is genuinely constrained by an organizational decision: "Is this a brainstorming session or a justification exercise? Both are valid — but they have different designs. Which are we doing?"

---

## 5. Premature Convergence

**Definition:** The team commits to a direction before the opportunity space or solution space has been adequately explored. The session moves from "first plausible idea" to "selected direction" without a genuine diverge phase.

**Detection signals:**
- The participant proposes a solution in Stage 1 (Frame) or Stage 2 (Discover).
- Stage 4 (Generate) produces only 1 concept before the participant says "okay, let's go with that."
- The participant wants to skip Stage 2 ("We know the problem — let's solve it") or Stage 4 ("We already know what we want to build").
- The first concept proposed in Stage 4 is immediately marked as the direction.

**Counter-move:**

1. Name the premature closure explicitly: "We have 1 concept. Our gate requires 3. We are not in Stage 5 yet."
2. Enforce the minimum quota: Do not advance Stage 4 with fewer than 3 concepts. Period.
3. If the participant insists on skipping Stage 2: "What is the cost of spending 10 minutes mapping opportunities before we solve? If we have missed a better opportunity, we will have built the wrong thing. Take the 10 minutes."
4. After generating the minimum, use a Provocation (see `techniques.md`, Technique 5) to force at least one concept that violates the dominant assumption.
5. State explicitly when the session ends without full convergence: "We have a ranked set rather than a single winner. That is a valid outcome. Stage 6 will design the test that breaks the tie."

---

## 6. Drift

**Definition:** The session moves off-topic — into scope creep, tangential problem areas, or meta-discussion about process rather than the task at hand. Unlike premature convergence (too fast), drift is too wide: the session expands beyond the agreed scope without a gate.

**Detection signals:**
- The conversation has been on the same sub-topic for 5+ turns without advancing a stage exit artifact.
- New problem areas are being introduced in Stage 4 (solution divergence) that belong in Stage 2 (opportunity divergence).
- The participant is discussing organizational politics, resourcing, or implementation logistics during ideation stages.
- The problem statement from Stage 1 is no longer the anchor for Stage 3 or Stage 4 outputs.

**Counter-move:**

1. Name the drift by stage: "We are in Stage [N]. The scope of this stage is [purpose]. What we are discussing belongs in [correct stage or outside scope]. Let us return."
2. Read back the Stage 1 problem statement: "Our agreed problem statement was [restate verbatim]. Does this new topic fall within that scope? If not, note it for a separate session and return to [current stage]."
3. Apply the time-box: "We have [N] turns remaining in this stage. What is the one thing we need to produce before we advance? Let us focus on that."
4. If the drift is persistent: "I am going to call a stage reset. We were in Stage [N], working on [exit artifact]. Let us resume there: [restate the last confirmed output and the next question]."
