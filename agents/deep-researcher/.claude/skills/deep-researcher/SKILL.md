---
name: deep-researcher
description: Provides the procedural logic for exhaustive, evidence-based research using the Search → Read → Identify Gaps loop. Applies EBSE frameworks (SLR, MSR, Case Studies) with mandatory source diversity, freshness annotation, and structured evidence output. Use for any deep research investigation requiring primary source confirmation and dissent coverage.
allowed-tools: WebSearch WebFetch Read Bash Grep Glob Write
---

# Deep Research Skill

This skill provides procedural logic for high-fidelity, evidence-based research. Apply it during Phase 1 (Discovery) of the deep-researcher workflow.

## Methodological frameworks

Select based on research goal:

**Systematic Literature Review (SLR):** Synthesize all available evidence on a specific question. Use for: technology evaluation, academic topics, standards and specifications.

**Mining Software Repositories (MSR):** Uncover architectural patterns from real code and activity data. Use for: library/framework evaluation, maintenance health, adoption trajectory.

**Case Studies & Continuous Discovery:** Investigate "how" and "why" in real-world context. Use for: historical events, product decisions, organizational changes, contested claims.

## The Research Loop (execute iteratively)

### Step 1 — Query formulation

Formulate **≥5 diverse search queries** covering:
- The primary claim or question (direct)
- The counter-position or skeptical angle (dissent)
- A primary/authoritative source angle (e.g., `site:gov`, `site:arxiv.org`, official documentation URL)
- A temporal angle (e.g., recent developments, historical origin)
- A domain-crossing angle (e.g., related fields, analogous cases)

Do not begin Step 2 until you have formulated all 5 queries and logged them to `$OUTPUT_DIR/checkpoint.md`.

### Step 2 — Multi-pass reading

For each source:
1. **Scan**: Read abstract/introduction/summary. Decide if worth deep-diving.
2. **Deep Dive**: Extract key claims, evidence, and exact quotes (≤30 words per quote). Log all findings to the Evidence Envelope format below.
3. **Verify**: For any claim from a tertiary or community source, find a primary source that confirms or refutes it. If no primary source can be found, tag the claim as **⚠️ UNVERIFIED — tertiary only**.

### Step 3 — Evidence Envelope format

Every finding MUST be recorded in this format in `$OUTPUT_DIR/checkpoint.md`:

```markdown
### [Finding Title]

- **Claim:** [one-line factual claim]
- **Evidence:** > "[exact quote ≤30 words]"
- **Source:** [Source Name](URL)
- **Source Type:** Primary / Secondary / Tertiary / Community
- **Freshness:** [YYYY-MM] — [CURRENT / STALE: >1yr for tech, >6mo for AI/ML, >2yr for specs]
- **Verification:** [Confirmed by: [Source](URL)] / [UNVERIFIED — no primary source found]
- **Confidence:** High / Medium / Low
```

### Step 4 — Gap identification

After ≥8 sources have been read, list:
- What is confirmed by ≥2 independent primary sources?
- What is claimed by only one source?
- What is the most important question that the research has NOT yet answered?
- What would falsify the primary claim? Has that been investigated?

### Step 5 — Checkpointing

Write current findings to `$OUTPUT_DIR/checkpoint.md` **every 10 tool calls**. Include:
- Summary of completed queries
- Number of sources read (by type)
- Open gaps
- Remaining queries to run

## Minimum evidence bar (do not exit Phase 1 without meeting these)

| Criterion | Minimum |
|-----------|---------|
| Distinct search queries | ≥5 |
| Sources read | ≥8 |
| Primary sources | ≥2 (at least 1 per major claim) |
| Source types represented | ≥3 distinct types |
| Freshness annotations | 100% — every source |
| Unverified community claims | Must be tagged ⚠️ or resolved |

## Tool selection strategy

- **Known authoritative domains**: Use direct WebFetch of the canonical URL; do not rely on search to find official docs.
- **Recent developments**: WebSearch with date filters.
- **Local context**: Grep/Read the local codebase before hitting the web for internal topics.
- **Verification of community claims**: Always follow with a WebFetch of the primary source, not just a search.

## Citation rules

- Cite every non-trivial claim immediately in-text: `[Source Name](URL)`
- Use blockquotes for exact text, ≤30 words
- Primary sources preferred; secondary acceptable with justification; tertiary/community require primary-source backup
- Flag stale content:
  - AI/ML topics: >6 months = stale
  - Frameworks, build tools, APIs: >1 year = stale
  - Specs, standards, protocols: >2 years = stale
  - Historical/political/social: always provide event date, not just publication date
