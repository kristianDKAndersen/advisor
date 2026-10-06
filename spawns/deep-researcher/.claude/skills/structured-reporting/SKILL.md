---
name: structured-reporting
description: Provides the logic for synthesizing research and audit findings into a structured final report using the Inverted Pyramid format. Enforces mandatory section schema, citation density requirements, and confidence levels. Use during Phase 3 (Synthesis) of the deep-researcher workflow.
last_edited: 2026-10-06
---

# Structured Reporting Skill

Logic for synthesizing the Phase 1 evidence and Phase 2 audit files into the final report.

## Audience default

Default audience: **senior decision-maker or technically literate generalist** who must act on findings but is not a domain specialist. Adapt only if your brief says otherwise:
- *Technical architects:* trade-offs, edge cases, implementation paths.
- *Executive/CTO:* long-term maintainability, strategic fit, risk.
- *Developers:* implementation details, API surface, code examples.

## Reporting architecture: Inverted Pyramid

The schema below is **mandatory**. Every section must appear. If data is insufficient for a section, write its header and state what is missing.

### Section 1: Executive Summary (TL;DR)

Maximum: 4 lines. Must contain:
- **Problem:** [what was investigated — one sentence]
- **Primary Finding:** [the main answer — one sentence]
- **Confidence:** [High / Medium / Low — from audit verdict]
- **Recommended Action:** [what to do — one sentence]

The executive summary must be complete enough that a reader who reads nothing else can make an informed decision.

### Section 2: Key Findings

Lead with the "So What?" — actionable insight before evidence.

For each finding:
```markdown
### Finding N: [title]
- **Claim:** [one sentence]
- **Evidence:** > "[direct quote ≤30 words]"
- **Source:** [Source Name](URL)
- **Confidence:** High / Medium / Low
- **Audit note:** [relevant ACH verdict from `ach-matrix.md`]
```

Minimum: 3 findings for any substantive investigation.

### Section 3: Counter-Narratives & Dissenting Views

For each major finding, include the counter-narrative from `counter-narratives.md`, then state whether it changes the recommended action and why.

If the research topic is contested (political, social, historical), this section must appear **before** Key Findings in the document order to signal epistemic humility.

### Section 4: Technical Analysis

For technical topics: include data tables, benchmarks, architectural diagrams (Mermaid syntax), code snippets.

For historical/social/political topics: include a dated timeline, named actors with their roles, documented causal chain with citations at each step.

Use Markdown tables for comparisons. Label confidence per data point.

### Section 5: Evidence Appendix

Full source list. Every source used in the body must appear here.

| # | Source Name | URL | Type | Freshness (YYYY-MM) | Sections Used |
|---|-------------|-----|------|---------------------|---------------|

**Citation density requirements:**
- Every substantive paragraph: ≥1 inline citation `[Source Name](URL)`
- Total citations in full report: ≥5
- Primary source citations: ≥2

### Section 6: Unresolved Gaps

Minimum: 2 items. If the research is genuinely exhaustive, write "None identified — justification: [explain why no gaps remain]." Do not write zero gaps without justification.

Format:
```markdown
- **Gap:** [what is unknown or unverifiable]
  *Why it matters:* [one sentence impact]
  *How to resolve:* [suggested follow-up]
```

### Section 7: Audit Summary

Paste the `AUDIT VERDICT:` paragraph from the end of `ach-matrix.md` verbatim, without paraphrase. Then list:
- **High-risk assumptions flagged:** [list from assumptions.md]
- **Findings with insufficient evidence:** [list any ⚠️ INSUFFICIENTLY EVIDENCED flags]

## Synthesis rules

- **Confidence rating:** assign High / Medium / Low to every major finding, consistent with the audit evidence tier (Tier 3-only evidence = Low at most).
- **State documented facts directly,** not as "it has been reported that ...".
- **Key evidence** follows the Finding template order in Section 2 (Claim, Evidence quote, Source).

## Completeness gate

Before returning the report, confirm: Section 1 is ≤4 lines; Section 2 has ≥3 findings; Sections 3 and 4 exist and are non-empty; Section 5 has ≥5 citations (≥2 primary); Section 6 has ≥2 gaps or an explicit "None identified" with justification; Section 7 has the verbatim audit verdict. Add any missing section before returning. Report `verdict: "partial"` only if input data is missing and you cannot generate a section.
