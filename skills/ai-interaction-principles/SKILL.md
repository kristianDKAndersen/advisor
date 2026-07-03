---
name: ai-interaction-principles
description: Checklist of 39 human-AI interaction design principles (Bakusevych, UX Collective 2026) for briefing or building user-facing AI features - AI UX, chatbots, agent products, AI-assisted workflows, or AI feature specs. Use when a task ships AI in front of a user and needs interaction-design constraints beyond raw model capability.
---

# AI Interaction Principles

39 principles for designing human-AI interaction, synthesized from six upstream
frameworks (OpenAI Model Spec, Anthropic Claude Constitution, Horvitz mixed-initiative
work, Google PAIR Guidebook, IBM's Generative AI principles, Microsoft's Guidelines
for Human-AI Interaction). Lean on these when scoping or reviewing a user-facing AI
feature - they are defaults, not law. Rules can be bent; record why when you bend one.

## Index (compact — full text in PRINCIPLES.md)

### 1. Probabilistic Foundation (1-3)
1. **Use AI only where it has a comparative advantage** [build]
2. **Design for generative variability - don't fight it** [build]
3. **Choose the interaction pattern based on the task** [build]

### 2. Expectation Setting (4-9)
4. **State what the system can do - and where its limits are** [both]
5. **Solve the blank-canvas problem** [build]
6. **Frame output as a starting point** [build]
7. **Signal the AI's role explicitly** [build]
8. **Adapt explanation and control to user expertise** [build]
9. **Represent the AI's nature honestly** [build]

### 3. Calibrated Trust (10-15)
10. **Provide provenance for claims, tools, and data** [both]
11. **Prefer provenance over confidence scores** [both]
12. **Make output cheap to verify** [both]
13. **The system must not run its own agenda** [build]
14. **Don't be sycophantic - design for honest pushback** [both]
15. **Respect creators and attribution** [both]

### 4. Transparency (16-18)
16. **Answer the five intelligibility questions** [build]
17. **Use progressive disclosure for explanations** [both]
18. **Show plans and traces for multi-step work** [both]

### 5. Control & Agency (19-24)
19. **Make AI assistance easy to accept - and easier to ignore** [build]
20. **Ask, don't guess, when uncertain** [both]
21. **Give global and granular controls** [build]
22. **Time interventions to attention** [build]
23. **Make AI assistance accessible and inspectable** [build]
24. **Show whose rule the system is following** [build]

### 6. Graceful Failure (25-28)
25. **Contain the damage when the AI is wrong** [both]
26. **Reduce precision when evidence is weak & surface parts needing review** [both]
27. **Design the human handoff** [both]
28. **Design the refusal path with good intent** [build]

### 7. Co-Creation (29-31)
29. **Keep generated output malleable** [build]
30. **Use friction to improve judgment, not to slow exploration** [both]
31. **Help users specify intent** [build]

### 8. Responsible Autonomy (32-35)
32. **Bound autonomy by reversibility and stakes** [both]
33. **Make data use explicit, permissioned, and revocable** [build]
34. **Protect third-party privacy** [both]
35. **Separate instructions, data, tools, and actions** [both]

### 9. Sustained Reliance (36-39)
36. **Design the wait, not just the result** [build]
37. **Make compute effort visible where it affects behavior** [build]
38. **Measure reliance, not just usage** [build]
39. **Design for model and data changes** [both]

## How to apply

For a brief that ships a user-facing AI feature: scan the index, pick the
`[build]`/`[both]`-tagged principles that bear on the feature, and append them
as a constraints section on the worker brief - number and title suffice for
most cases. Open `PRINCIPLES.md` only when a picked principle needs its full
description to resolve a brief ambiguity. `[advisor]`-tagged principles govern
the advisor's own orchestration, not shipped features, and are not brief
constraints.

Full text, tags, thesis, and attribution: `PRINCIPLES.md`.
