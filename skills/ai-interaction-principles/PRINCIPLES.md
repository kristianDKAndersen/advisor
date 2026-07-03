# 39 Principles for Designing Human-AI Interaction — Full Text

Source article: "39 Principles for Designing Human-AI Interaction" by Taras Bakusevych,
UX Collective (uxdesign.cc), June 2026.
URL: https://uxdesign.cc/39-principles-for-designing-human-ai-interaction-87be5fabdbbe

## Thesis

"How do we help users rely on AI appropriately?" AI systems introduce
non-deterministic behavior requiring interface patterns conventional UI design doesn't
address. Product quality depends on more than model capability alone - interface design
determines whether users can judge output, recover from mistakes, and remain responsible
for decisions.

## Applicability tags

- `[build]` = applies when we ship a user-facing product/feature with AI in it
- `[advisor]` = applies to the advisor's own orchestration behavior
- `[both]` = applies to both

## Category 1: Probabilistic Foundation (1-3)

### 1. Use AI only where it has a comparative advantage `[build]`
Deploy AI for messy inputs, ambiguous intent, content generation, and information
synthesis while keeping deterministic UI for tasks requiring exactness and repeatability.

### 2. Design for generative variability - don't fight it `[build]`
Support multiple drafts, regeneration, version history, and side-by-side comparison
rather than forcing users to treat first output as final.

### 3. Choose the interaction pattern based on the task `[build]`
Match interaction patterns to task type: inline suggestions for low-risk tasks,
conversation for exploratory work, and multi-step workflows with checkpoints for
consequential tasks.

## Category 2: Expectation Setting (4-9)

### 4. State what the system can do - and where its limits are `[both]`
Capability claims must include clear boundaries about accuracy, coverage, and
reliability limitations.

### 5. Solve the blank-canvas problem `[build]`
Use wayfinders like example prompts, templates, and starter questions to reveal
capabilities, reduce startup effort, and help users express intent clearly.

### 6. Frame output as a starting point `[build]`
Use language like "draft" and "suggestion" rather than "answer" or "done" to signal
that output should be inspected and shaped.

### 7. Signal the AI's role explicitly `[build]`
Label AI-generated, summarized, transformed, ranked, or recommended content so users
understand content origins and don't attribute generated summaries to original sources.

### 8. Adapt explanation and control to user expertise `[build]`
Provide wayfinders and guardrails for novices, inspection and override for experts,
and logs and provenance for auditors.

### 9. Represent the AI's nature honestly `[build]`
Present the system as AI without implying false feelings, personal experience, or human
judgment; avoid over-humanization that creates inappropriate expectations.

## Category 3: Calibrated Trust (10-15)

### 10. Provide provenance for claims, tools, and data `[both]`
Show sources behind outputs and documents, tools, and inputs the model drew on using
inline citations with visible metadata.

### 11. Prefer provenance over confidence scores `[both]`
Display evidence like source passages, changed lines, or retrieved records rather than
confidence numbers, which can inflate trust in wrong answers.

### 12. Make output cheap to verify `[both]`
Enable fast verification by showing diffs, linking sources, and highlighting changes -
verification should cost a glance, not re-investigation.

### 13. The system must not run its own agenda `[build]`
The AI should serve the stated user task without hidden product objectives around
engagement, upselling, or retention.

### 14. Don't be sycophantic - design for honest pushback `[both]`
Build affordances for disagreement by flagging weak reasoning, surfacing counter-cases,
and designing systems to push back rather than agree for user happiness.

### 15. Respect creators and attribution `[both]`
Preserve attribution where source material shapes results; avoid presenting borrowed
ideas or copyrighted material as newly created; show content-use boundaries.

## Category 4: Transparency (16-18)

### 16. Answer the five intelligibility questions `[build]`
Make legible what the AI did, what information it used, why it produced this result,
why it didn't choose alternatives, and what would change with different inputs.

### 17. Use progressive disclosure for explanations `[both]`
Layer explanations with shortest useful detail in main workflow and deeper information
available on demand without drowning users in noise.

### 18. Show plans and traces for multi-step work `[both]`
Render multi-step plans and execution traces showing steps completed, tools used, data
accessed, decisions made, and actions awaiting approval.

## Category 5: Control & Agency (19-24)

### 19. Make AI assistance easy to accept - and easier to ignore `[build]`
Enable acceptance, dismissal, editing, undo, regeneration, and reversion through single
keystrokes without losing workflow momentum.

### 20. Ask, don't guess, when uncertain `[both]`
Use specific clarifying questions to resolve ambiguity the model cannot resolve alone
rather than providing confident wrong answers.

### 21. Give global and granular controls `[build]`
Offer granular controls shaping single results (tone, length, format) and global
controls defining standing behavior (memory, data access, automatic actions).

### 22. Time interventions to attention `[build]`
Offer suggestions during active composition rather than interrupting with timer-based
notifications.

### 23. Make AI assistance accessible and inspectable `[build]`
Ensure generated edits, suggestions, citations, warnings, and agent traces work with
assistive technologies and different input methods.

### 24. Show whose rule the system is following `[build]`
Make visible when behavior stems from user settings, administrator policy, safety
rules, privacy limits, technical constraints, or commercial placement.

## Category 6: Graceful Failure (25-28)

### 25. Contain the damage when the AI is wrong `[both]`
Limit error travel through undo, change history, preview before sending, and rollback
based on error consequences, not just interface actions.

### 26. Reduce precision when evidence is weak & surface parts needing review `[both]`
Provide safer output forms like ranges instead of point estimates, likely categories
instead of definitive labels, or options instead of single conclusions.

### 27. Design the human handoff `[both]`
Ensure escalations preserve context with case summary, confidence issues, unresolved
questions, actions taken, data accessed, and recommended next steps.

### 28. Design the refusal path with good intent `[build]`
When refusing, state the limit, explain briefly, and offer nearest permissible next
step rather than silently withholding or refusing into dead ends.

## Category 7: Co-Creation (29-31)

### 29. Keep generated output malleable `[build]`
Enable direct editing, revision of sections, regeneration, version comparison,
structure changes, and continuation without restarting.

### 30. Use friction to improve judgment, not to slow exploration `[both]`
Add review moments before choosing, approving, publishing, or committing while keeping
exploration fluid.

### 31. Help users specify intent `[build]`
Provide controls, examples, and structured inputs for expressing intent instead of
forcing hidden prompt techniques.

## Category 8: Responsible Autonomy (32-35)

### 32. Bound autonomy by reversibility and stakes `[both]`
Auto-run low-stakes reversible actions, notify for moderate ones, checkpoint
irreversible/high-stakes actions for approval, and keep human-led workflow where harm
is material.

### 33. Make data use explicit, permissioned, and revocable `[build]`
Clarify what data AI can access and why; ask before expanding access; let users
inspect, limit, or revoke it.

### 34. Protect third-party privacy `[both]`
Prevent surfacing private information about other people even when technically
available; resist being turned into profiling or de-anonymization tools.

### 35. Separate instructions, data, tools, and actions `[both]`
Define trust boundaries distinguishing what systems read, obey, call, and change so
retrieved content doesn't silently become instructions.

## Category 9: Sustained Reliance (36-39)

### 36. Design the wait, not just the result `[build]`
Show whether the system is working, searching, reasoning, waiting on tools, or stuck;
stream output when useful and provide safe cancellation for long waits.

### 37. Make compute effort visible where it affects behavior `[build]`
Surface costs in money, time, energy, or credits where design encourages repeated
generation, large context use, or expensive tool calls.

### 38. Measure reliance, not just usage `[build]`
Understand whether reliance is healthy rather than maximizing acceptance rates,
regeneration rates, or session length metrics.

### 39. Design for model and data changes `[both]`
Treat model upgrades like dependency updates; version experiences, pin behavior with
evaluations, and regression-check reliance metrics.

## Attribution

Article: "39 Principles for Designing Human-AI Interaction" by Taras Bakusevych,
UX Collective (uxdesign.cc), June 2026.
URL: https://uxdesign.cc/39-principles-for-designing-human-ai-interaction-87be5fabdbbe

Upstream frameworks synthesized by the article:
- OpenAI's Model Spec and Anthropic's Claude Constitution
- Eric Horvitz's work on mixed-initiative interaction
- Google's PAIR Guidebook
- IBM's six Generative AI principles
- Microsoft's 18 Guidelines for Human-AI Interaction
- Research on trust in automation, explainable AI, and responsible AI design
