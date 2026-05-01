---
name: structured-reporting
description: Provides the logic for synthesizing research and audit findings into a structured final report using the Inverted Pyramid format. Enforces mandatory section schema, citation density requirements, and confidence levels. Use during Phase 3 (Synthesis) of the deep-researcher workflow.
---

# Structured Reporting Skill

This skill provides the logic for the report-architect to synthesize complex, audited data into a clear, high-signal report.

## Audience default

Default audience: **senior decision-maker or technically literate generalist** — someone who must act on findings but is not a domain specialist. Adapt only if the orchestrator's task prompt specifies otherwise:
- *For technical architects:* Emphasize trade-offs, edge cases, implementation paths.
- *For executive/CTO:* Emphasize long-term maintainability, strategic fit, risk.
- *For developers:* Emphasize implementation details, API surface, code examples.

## Reporting architecture: Inverted Pyramid

The schema below is **mandatory**. Every section must appear in the final report. If data is insufficient for a section, write the section header and state what is missing — do not silently omit it.

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
- **Audit note:** [relevant ACH verdict from bias-auditor]
```

Minimum: 3 findings for any substantive investigation.

### Section 3: Counter-Narratives & Dissenting Views

**This section is mandatory.** Do not minimize it or bury it after the main findings.

For each major finding, include the counter-narrative from the bias audit. Add your synthesis: does the counter-narrative change the recommended action? Why or why not?

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

Paste the bias-auditor's AUDIT VERDICT verbatim. Do not paraphrase or summarize it. Then list:
- **High-risk assumptions flagged:** [list from assumptions.md]
- **Findings with insufficient evidence:** [list any ⚠️ INSUFFICIENTLY EVIDENCED flags]

## Synthesis rules

- **Signal over noise:** Remove conversational filler. Every sentence must add information.
- **Confidence rating mandatory:** Assign High / Medium / Low to every major finding. The rating must be consistent with the audit evidence tier: Tier 3-only evidence = Low at most.
- **No passive-voice hedging for documented facts:** "The shooting occurred on December 4, 2016" not "It has been reported that a shooting may have occurred."
- **Quote → Claim → Source in that order for key evidence:** Quote the source; state the claim it supports; cite the URL.

## Mandatory completeness gate

Before returning the report, run through this checklist and fail loudly if any item is unmet:

- [ ] Section 1 present and ≤4 lines
- [ ] Section 2 present with ≥3 findings
- [ ] Section 3 present (not empty)
- [ ] Section 4 present (may be brief for low-data topics, but must exist)
- [ ] Section 5 present with ≥5 citations
- [ ] Section 6 present with ≥2 gaps or explicit "None identified" + justification
- [ ] Section 7 present with verbatim audit verdict

If any check fails, add the missing section before returning. Report `verdict: "partial"` only if you genuinely cannot generate a section due to missing input data.
