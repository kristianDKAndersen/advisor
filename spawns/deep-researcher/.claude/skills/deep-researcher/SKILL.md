---
name: deep-researcher
description: Provides the procedural logic for exhaustive, evidence-based research using the Search → Read → Identify Gaps loop. Applies EBSE frameworks (SLR, MSR, Case Studies) with mandatory source diversity, freshness annotation, and structured evidence output. Use for any deep research investigation requiring primary source confirmation and dissent coverage.
allowed-tools: WebSearch WebFetch Read Bash Grep Glob Write
last_edited: 2026-10-06
---

# Deep Research Skill

Procedural logic for evidence-based research, applied during Phase 1 (Discovery).

## Methodological frameworks

Select based on research goal:

- **Systematic Literature Review (SLR):** all available evidence on one question - technology evaluation, academic topics, standards and specifications.
- **Mining Software Repositories (MSR):** architectural patterns from real code and activity data - library/framework evaluation, maintenance health, adoption trajectory.
- **Case Studies & Continuous Discovery:** "how" and "why" in real-world context - historical events, product decisions, organizational changes, contested claims.

## The Research Loop (execute iteratively)

### Step 1 — Query formulation

Formulate **≥5 diverse search queries** covering:
- The primary claim or question (direct)
- The counter-position or skeptical angle (dissent)
- A primary/authoritative source angle (e.g., `site:gov`, `site:arxiv.org`, official documentation URL)
- A temporal angle (e.g., recent developments, historical origin)
- A domain-crossing angle (e.g., related fields, analogous cases)

Log all 5 queries to `$OUTPUT_DIR/checkpoint.md` before starting Step 2.

### Step 2 — Multi-pass reading

For each source:
1. **Scan**: Read abstract/introduction/summary. Decide if worth deep-diving.
2. **Deep Dive**: Extract key claims, evidence, and exact quotes (≤30 words per quote). Log all findings to the Evidence Envelope format below.
3. **Verify**: For any claim from a tertiary or community source, WebFetch a primary source that confirms or refutes it (a search alone is not verification). If none can be found, tag the claim **⚠️ UNVERIFIED - tertiary only**.

### Step 3 — Evidence Envelope format

Every finding MUST be recorded in this format in `$OUTPUT_DIR/checkpoint.md`:

```markdown
### [Finding Title]

- **Claim:** [one-line factual claim]
- **Evidence:** > "[exact quote ≤30 words]"
- **Source:** [Source Name](URL)
- **Source Type:** Primary / Secondary / Tertiary / Community
- **Freshness:** [YYYY-MM] - [CURRENT / STALE per the thresholds below]
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
- Elapsed time (`elapsed Ns / Ts`, per your Phase budget)
- Summary of completed queries
- Number of sources read (by type)
- Open gaps
- Remaining queries to run

## Minimum evidence bar

The Phase 1 minimums in your prompt (queries, sources read, primary sources, source types, freshness on every source) gate the exit from Phase 1. Also tag every unverified community claim ⚠️ or resolve it.

## Tool selection strategy

- **Known authoritative domains**: WebFetch the canonical URL directly; do not rely on search to find official docs.
- **Recent developments**: WebSearch with date filters.
- **Internal topics**: Grep/Read the local codebase before the web.

## Citation rules

- Cite every non-trivial claim immediately in-text: `[Source Name](URL)`
- Use blockquotes for exact text, ≤30 words
- Primary sources preferred; secondary acceptable with justification; tertiary/community require primary-source backup
- Stale thresholds: AI/ML >6 months; frameworks, build tools, APIs >1 year; specs, standards, protocols >2 years. For historical/political/social topics, give the event date, not just the publication date.
