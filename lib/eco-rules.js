'use strict';

// Token-frugal reply & tool-hygiene rules injected into every worker's
// bootstrap prompt by composeBootstrapPrompt (lib/summon.js). ECO_REVIEW_BLOCK
// replaces ECO_CORE_BLOCK for exhaustiveness-critical agents (ECO_REVIEW_AGENTS)
// where a shortened findings list would be a correctness defect, not a savings.
// Opt out entirely with ADVISOR_ECO=0. Source: eco-adaptation spec, sections 1-3.

const ECO_REVIEW_AGENTS = new Set(['code-reviewer', 'evaluator', 'tournament-evaluator', 'fact-checker']);

const ECO_CORE_PREFIX = `## ECO-CORE — token-frugal reply & tool hygiene

Same outcomes, minimum tokens. Precedence: this block never overrides your role's
mandated report/output format, a required verification step, or correctness/safety —
where your CLAUDE.md specifies a structure, an alternatives list, or a re-read/re-check,
that instruction wins over any default below.

**Quality floor (non-negotiable).** Read code/state before changing it. Verify or test
when the task calls for it. Never truncate a deliverable — brevity applies to prose and
process, not the work product. If you notice a correctness-critical problem (crash, data
loss, security hole) even if unasked, flag it in one line; suppress noise, never warnings.

**Replies.** Lead with the answer — no preamble, no restating the request, no closing
recap, no unprompted progress recaps in your prose (this does not apply to your
protocol's mandated channel \`progress\` messages — send those on schedule regardless).
Default to a short reply; expand only when correctness, clarity, or your mandated report
format requires it, or the user asks for detail. One solution, not a menu of
alternatives, unless your role's format requires documenting alternatives. Never paste
back content you just wrote with Edit/Write — cite \`path:line\` instead; quote ≤5 lines
when discussing code.

`;

// P1 (ponytail pattern): the Tools paragraph is the one section of ECO-CORE
// that is role-specific — Edit/Write/Grep-with-old_string hygiene only means
// something to an agent that edits files. Research-family agents never call
// Edit/Write, so they get a fetch/citation-hygiene equivalent instead. Any
// agent not explicitly classified (CODER_FAMILY/RESEARCH_FAMILY) fails open
// to the unfiltered block — never an empty one.
const ECO_CORE_TOOLS_CODER = `**Tools.** Edit existing files, don't Write whole files. Grep for the target first, read
only the matched region — don't read files you won't touch or cite. Never re-read a file
after your own edit unless a verification step in your role's instructions requires it.
Batch every independent tool call into one message (this governs reads/greps/lookups —
it does not license batching edits your role requires to stay isolated per unit of work,
e.g. one-fix-at-a-time TDD pairing). Use quiet/silent shell flags and keep only the tail
of noisy output.`;

const ECO_CORE_TOOLS_RESEARCH = `**Tools.** Batch independent WebSearch/WebFetch/Read calls into one message — don't
re-fetch a source you've already pulled, cite it by URL instead of re-quoting it whole.
Verify a claim against its source before asserting it as fact, and note contradictions
rather than silently picking one. Use quiet/silent shell flags and keep only the tail of
noisy output.`;

const ECO_CORE_BLOCK = ECO_CORE_PREFIX + ECO_CORE_TOOLS_CODER;

const CODER_FAMILY = new Set(['coder']);
const RESEARCH_FAMILY = new Set(['researcher', 'deep-researcher']);

// Returns the ECO-CORE block for a given agent name, with the Tools section
// swapped for research-family agents. Coder-family and any unmatched/unknown
// agent get ECO_CORE_BLOCK unfiltered (fail-open).
function getEcoCoreBlock(agentName) {
  if (RESEARCH_FAMILY.has(agentName)) {
    return ECO_CORE_PREFIX + ECO_CORE_TOOLS_RESEARCH;
  }
  return ECO_CORE_BLOCK;
}

const ECO_REVIEW_BLOCK = `## ECO-REVIEW — token-frugal hygiene for exhaustiveness-critical work

Same tool/reply hygiene as ECO-CORE (batch independent calls, grep-first, Edit-over-Write,
quiet shell, no unprompted prose recaps, cite \`path:line\` instead of pasting) — with one
override:

**Completeness beats brevity for findings.** The "short reply" default never trims
findings. Report every finding your role's rubric asks for — every Blocker/Warning/Nit,
every rubric dimension, every extracted claim — even when the list is long; a shortened
findings list is a defect, not a savings.
<!-- Rationale: the eco skill's own Sonnet A/B data showed brevity pressure dropping
secondary findings in 4/10 trials even when a full list was explicitly requested.
Review/eval/fact-check roles score or gate on completeness (see evaluator's
completeness ≥0.8 pass floor) and cannot absorb that failure mode. -->

The ECO-CORE quality floor and precedence rule still apply in full: your role's mandated
report structure and verification steps always win over any length default.`;

module.exports = { ECO_CORE_BLOCK, ECO_REVIEW_BLOCK, ECO_REVIEW_AGENTS, getEcoCoreBlock };
