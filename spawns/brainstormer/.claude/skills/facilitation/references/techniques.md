# Technique Cards

Load this file when a stage is stuck. Each card names when to deploy it, a facilitator script, an anti-drift mechanism, and an anti-premature-convergence mechanism.

---

## Technique 1: Brainwriting-Style Silent Generation

**When to deploy:**
- Stage 4 (Generate) has produced fewer than 3 concepts after 3 turns.
- Participant is anchoring on the first concept and cannot move away from it.
- Group setting where a dominant voice is crowding out contributions.

**Evidence basis:** Simultaneous written generation outperforms verbal turn-taking on idea quantity (Diehl and Stroebe 1987, 4 controlled experiments). Mechanism: eliminates production blocking by removing sequential turn-taking.

**Facilitator script:**

Step 1: "We are switching to a written generation round. I will give you 5 minutes. In that time, write 3 ideas in response to this prompt: '[restate the target opportunity in one sentence]'. Write complete sentences. Do not evaluate as you write. If you run out of ideas before 5 minutes, keep writing — the most useful ideas often come after the obvious ones."

Step 2: After 5 minutes: "Time. Read your 3 ideas back to me now."

Step 3: "Take the idea that surprised you most. Build on it: what would have to change about [product / process / assumption] to make it work? Give me 3 extensions."

Step 4: Add all output to the idea ledger with maturity `captured`. Then proceed to gate check.

**Anti-drift mechanism:** The written format eliminates the verbal channel. Conversational tangents require a verbal channel — they cannot occur when all ideation is written.

**Anti-premature-convergence mechanism:** Evaluation is deferred until after the generation round ends. No critique is permitted during the writing phase. Facilitator enforces this by not responding to evaluative statements until step 4.

**Adaptation for AI-mediated text sessions:** The participant submits written ideas before seeing any feedback. Do not acknowledge or comment on any idea until all 3 are submitted. Then read all 3 back before adding any comment.

---

## Technique 2: SCAMPER

**When to deploy:**
- Stage 4 (Generate) is producing variations on the same idea.
- Idea space feels exhausted after the initial batch.
- Participant says "I can't think of anything else."

**SCAMPER prompts (apply all 7 in sequence — do not skip):**

| Letter | Prompt template |
|--------|-----------------|
| S — Substitute | "What component, material, step, or person in [existing approach] could be replaced with something else?" |
| C — Combine | "What if you merged [existing approach] with [an unrelated product or process]? What would the hybrid do?" |
| A — Adapt | "What solution from a completely different industry addresses a structurally similar problem? How would you adapt it here?" |
| M — Modify / Magnify / Minify | "What would happen if you made [the core mechanic] 10× larger, faster, or more frequent? What if you made it 10× smaller?" |
| P — Put to another use | "What if [the existing thing] were used by a completely different actor or in a completely different context?" |
| E — Eliminate | "What component or step of [existing approach] could be removed entirely? What would still work?" |
| R — Reverse / Rearrange | "What if the sequence of [the process] were reversed? What if the roles of [actor A] and [actor B] were swapped?" |

**Facilitator script:**

Opening: "We will run a SCAMPER pass. I will give you one prompt at a time. For each, generate at least 1 idea. We do not evaluate until all 7 prompts are complete. Checklist: [S C A M P E R]."

Per prompt: "Prompt [letter]: [prompt template]. Any idea is valid. What do you have?"

Closing gate: "We have completed all 7 SCAMPER prompts. Now we can evaluate: which of these ideas is worth adding to the concept list?"

**Anti-drift mechanism:** The SCAMPER checklist. The session has not covered SCAMPER until all 7 letters are complete. Facilitator can audit completeness in real time ("We have done S, C, A — M, P, E, R remain").

**Anti-premature-convergence mechanism:** Evaluation is explicitly deferred until all 7 prompts have received at least 1 response. The facilitator enforces this: "Evaluation after all 7. What does [next letter] give you?"

---

## Technique 3: Six Thinking Hats Frame Rotation

**When to deploy:**
- Stage 5 (Decide) evaluation is one-dimensional (all benefit, no risk; or all risk, no benefit).
- Groupthink signal: participant is agreeing with all assessments without surfacing counterpoints.
- The group has been in the same evaluative frame for more than 3 turns.

**Hat definitions:**

| Hat | Mode | What to surface |
|-----|------|-----------------|
| White | Facts and data | What do we know? What data exists? What is missing? |
| Yellow | Benefits and value | What is the strongest argument for this? What value does it create? |
| Black | Risks and cautions | What could fail? What assumption is most dangerous? |
| Green | Alternatives and creativity | What else is possible? What have we not considered? |
| Red | Emotions and intuition | What is your gut reaction? What feels wrong even if you can't explain it? |
| Blue | Process management | Are we asking the right question? What is the most useful next step? |

**Standard sequence for evaluation:** White → Yellow → Black → Green → Red → Blue (close)

**Facilitator script:**

Opening (Blue Hat): "We are switching to a Six Hats evaluation pass. I will name a hat. All thinking shifts to that mode — even if you see a concern from another hat. We will reach the right hat for every concern. Sequence: White, Yellow, Black, Green, Red, Blue."

At each hat: "Hat: [color]. [Mode description]. [Prompt]. [Timer: 2 minutes per hat.]"

At Black Hat (most important for this use): "Black Hat now. Every weakness, risk, and dangerous assumption — bring it now. This is the designated space for criticism. What could fail with [concept]?"

Blue Hat close: "Blue Hat: process close. What did we decide? What is the one action this evaluation produces?"

**Anti-drift mechanism:** Blue Hat (process/meta hat) is worn by the facilitator throughout. If a participant contributes something off-mode — a risk comment during Yellow Hat — redirect: "That is a Black Hat concern. We will get to it. For now, Yellow Hat: what is the value argument?"

**Anti-premature-convergence mechanism:** Black Hat is sequenced after Yellow Hat. Critical evaluation is not permitted while the group is in generative or benefit-mapping mode. The sequence enforces temporal separation of generation and evaluation.

**Release valve:** At non-Black-Hat moments, ask: "Is there anything you are holding that belongs in a later hat? I will note it and we will get to it."

---

## Technique 4: Lotus Blossom Expansion

**When to deploy:**
- Stage 2 (Discover) has fewer than 5 opportunity areas after initial elicitation.
- One opportunity area dominates and others are underdeveloped.
- The participant says the problem is "really just one thing."

**Structure:** A center theme expands into 8 surrounding petals. Each petal then becomes the center of its own 8-petal expansion. Full expansion = 9 center cells + 64 petal cells.

For a brainstorming session, use level 1 only (1 center + 8 petals = 9 cells) unless depth is needed.

**Facilitator script:**

Step 1: "We are using a Lotus Blossom expansion. The core challenge goes in the center: [state the problem]. We will identify 8 dimensions or sub-themes around it. No solutions — we are mapping the space."

Step 2: "For the center '[problem]', name 8 aspects, pain points, or sub-problems within it. Give me one at a time."

Step 3 (if deeper expansion is needed for one petal): "Let us expand petal '[petal name]'. It is now the center of its own blossom. Name 8 aspects within this dimension."

Step 4: "All [N] petals are populated. Which 3 represent the most generative space? These become candidates for Stage 3 Focus."

**Anti-drift mechanism:** Structural constraint — the petals must be populated in a defined order. An incomplete petal is visible as a gap. Drift to tangents is caught by the unfilled grid.

**Anti-premature-convergence mechanism:** The completion requirement makes premature convergence on one sub-theme structurally costly. A team that focuses only on petal 1 still has petals 2–8 to fill.

---

## Technique 5: Provocation (Po Technique)

**When to deploy:**
- Stage 4 (Generate) is stuck with ideas that all look similar.
- Every concept proposed uses the same mechanism.
- The participant cannot generate a concept that violates a dominant assumption.

**Mechanism:** A deliberately impossible or absurd constraint related to the problem displaces thinking from its current track. The provocation is NOT meant to be solved literally — it is meant to push thinking sideways.

**Provocation generation templates:**

1. Reverse the core assumption: "Po: [the product] must be [the opposite of its core function]."
2. Remove a dependency: "Po: [the product] must work without [the thing it relies on most]."
3. Exaggerate to absurdity: "Po: every customer must use [the product] 100× per day."
4. Impossible constraint: "Po: the solution must cost nothing and take no time."
5. Role reversal: "Po: the customer provides the service and the company receives it."

**Facilitator script:**

"Before we continue — I want to introduce a provocation. A provocation is a deliberately impossible statement. Do not solve it literally. Let it push your thinking sideways and tell me what it suggests that you would not have reached otherwise."

"Provocation: Po, [provocation statement]. What does that make you think of? What direction does it push you toward, even if the provocation itself is impossible?"

"Take the direction it suggested and try to extract a real concept from it. What is the kernel of a real idea hidden in that provocation?"

**Anti-drift mechanism:** The provocation interrupts the current logical chain. After a provocation turn, it is structurally awkward to return to the previous anchored idea without naming why.

**Anti-premature-convergence mechanism:** The provocation makes convergence on the current solution trajectory momentarily impossible. The conceptual path is disrupted and the participant must consciously re-choose it — which creates the decision point where a different choice can emerge.
