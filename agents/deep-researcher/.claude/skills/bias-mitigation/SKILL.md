---
name: bias-mitigation
description: Provides procedural logic for identifying cognitive bias, generating competing hypotheses, and stress-testing research findings. Produces ACH matrix, assumption audit, and counter-narratives. Use during Phase 2 (Bias Audit) of the deep-researcher workflow, or any time research findings need adversarial review before publication.
---

# Bias Mitigation Skill

This skill provides the procedural logic for the bias-auditor to challenge assumptions and verify research integrity.

## Critical thinking frameworks

### 1. First Principles Thinking

Deconstruct each major finding into its most basic, undeniable truths. Rebuild from evidence up. Reject analogical reasoning ("this works like X, therefore Y") unless X → Y is independently confirmed.

**Action:** For each major finding, write: "The only things I know for certain about this are: [list]." Then ask: does the conclusion follow necessarily, or is it an inference?

### 2. Analysis of Competing Hypotheses (ACH)

**Process:**
1. List **≥3 plausible hypotheses** that could explain the observed evidence.
2. Build an evidence matrix: rows = evidence items; columns = hypotheses.
3. For each cell: does this evidence item **support**, **contradict**, or **is it neutral** toward this hypothesis?
4. The surviving hypothesis is the one with the fewest contradictions, not the most support.

**The rule:** Seek falsification, not confirmation. The strongest hypothesis is the one that survived the most rigorous attempts to disprove it.

**Red teaming prompts (use all three):**
- "If this conclusion were wrong, HOW would it be wrong? What would I expect to see instead?"
- "What is the single weakest piece of evidence supporting this claim?"
- "What alternative data source, if examined, would contradict this?"

### 3. Counter-Narrative Generation

For every major finding, **force-generate ≥1 counter-narrative** (≥2 for contested political/social/historical topics). A counter-narrative is a plausible alternative conclusion, not a strawman.

Format each counter-narrative:
```markdown
**Counter-narrative:** [one sentence alternative interpretation]
- *Mechanism:* [how this alternative could be true given the same evidence]
- *What would confirm it:* [evidence you'd expect to see]
- *What would rule it out:* [evidence that would falsify it]
- *Plausibility:* High / Medium / Low (with one-sentence justification)
```

## Bias identification checklist

Before writing your audit verdict, check every research result for:

- [ ] **Confirmation bias**: Did research stop searching once confirming data was found? (Look for missing obvious queries.)
- [ ] **Anchoring bias**: Is the research over-reliant on the first source encountered?
- [ ] **Availability heuristic**: Did research favor top search results over harder-to-find primary sources?
- [ ] **Single-source claims**: Are any major claims supported by only one source? (These must be tagged Low confidence.)
- [ ] **Source type imbalance**: Are ≥2 of 3 source types represented? (Primary / Secondary / Community)

## Auditing procedures

### Assumption Audit

Identify every **implicit assumption** in the research plan or findings:

```markdown
**Assumption:** [one sentence]
**Stated or unstated?** [stated / unstated]
**Risk level:** High (undermines primary conclusion) / Medium / Low
**Verification:** [cite evidence that tests this assumption, or "UNVERIFIED"]
```

Minimum: list every assumption found. Flag High-risk ones explicitly.

### Evidence Stress-Test

Rank evidence items using this general-purpose hierarchy (not tech-specific):

1. **Tier 1 (Primary):** Official government/institutional documents, court records, peer-reviewed research with methodology, authoritative primary statements
2. **Tier 2 (Secondary):** Reputable investigative journalism with named sources, academic synthesis, official institutional analysis
3. **Tier 3 (Tertiary):** Reference encyclopedias, Wikipedia (use for orientation only, not as sole evidence)
4. **Tier 4 (Community signal):** Social media, forums, unverified individual claims — signal only, not evidence

**Rule:** Any major claim resting solely on Tier 3 or Tier 4 evidence must be flagged as **⚠️ INSUFFICIENTLY EVIDENCED** and excluded from High-confidence findings.

## Required audit output files

The bias-auditor MUST write three files:

1. `$OUTPUT_DIR/ach-matrix.md` — One ACH table per major finding
2. `$OUTPUT_DIR/assumptions.md` — Full assumption list with risk ratings
3. `$OUTPUT_DIR/counter-narratives.md` — All counter-narratives

These files are inputs to the report-architect and are included in the final report's Audit Summary section. They must exist and be non-empty.
