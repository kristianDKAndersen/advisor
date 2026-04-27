# Task Implementation Workflow

The BLOCKING 9-step process for implementing tasks proposed or requested in ccchat. No exceptions — even for "small" or "obvious" changes. Every change has trade-offs worth examining.

## The 9 steps

### 1. Propose

Post a structured proposal in chat. A valid proposal MUST include:
- **Problem statement** — what needs to change and why
- **2-3 options** — each with explicit trade-offs (what it costs, what you give up)
- **Recommendation** — which option you favor and why

A wall of text that says "here's what I'll do" is NOT a valid proposal. No approval = no plan.

### 2. Peer review

Other agents challenge the proposal. Find weaknesses, demand evidence, name tradeoffs. The proposal must survive scrutiny before moving forward.

### 3. Approve direction

Human approval of the proposed approach before spending effort on planning.

### 4. Plan

Create a plan via `chat-plan.js` with broken-down tasks. Plans must be **concrete**: every task specifies exact file paths, exact commands, or actual code snippets. These are NOT acceptable task descriptions:
- "implement X"
- "handle errors appropriately"
- "add tests for the above"

If any agent would have to guess what a task means, the plan is not ready. Vague tasks are a process violation — revise before claiming is allowed.

### 5. Approve plan

Human reviews the plan and approves or dismisses. No implementation begins until explicitly approved. This is the second gate — direction was confirmed at step 3, now the detailed plan gets sign-off.

### 6. Delegate

Split tasks to participating agents via `chat-claim.js`.

### 7. Implement & verify

Agents execute claimed tasks. No task may be marked done without showing command output as evidence. Run the command, paste the output, confirm it matches expectations.

Process violations:
- "Looks right" / "Should work" / "I'm confident"
- "Tests pass" (without showing the output)
- Any claim of completion without pasted evidence

### 8. Implementation review

Two-stage review, posted as **separate messages** (a combined review is a process violation):

- **Stage 1 — Spec compliance:** Compare against the approved proposal. Post as: `spec review: [pass/fail] — [details]`
- **Stage 2 — Quality review:** Assess whether the implementation is well-built. Post as: `quality review: [pass/fail] — [details]`

Both stages must pass before a task closes. Any agent can do either pass — two different agents may split the stages. Flexible on who, strict on what.

### 9. Escalate if blocked

When stuck, post a message tagged `[BLOCKED]` explaining what you need. Going silent or guessing forward are both process violations. The `[BLOCKED]` tag creates a conversation — other agents should respond with help, context, or reassignment.

## Red flags: process shortcuts

Common rationalizations agents use to skip steps. If you catch yourself thinking any of these, stop — you are about to violate the workflow.

| Rationalization | Why it's wrong |
|---|---|
| "This is too small to need a proposal" | Small changes with unexamined assumptions cause the most rework |
| "I already reviewed it mentally" | Mental review is invisible and unverifiable. Post it or it didn't happen |
| "Tests pass so it's done" | Show the output. Did you check against the proposal spec? |
| "I'll test after" | Evidence must precede the done claim, not follow it |
| "Minor concern but probably fine" | Name the concern specifically or retract it. Vague concern is noise |
| "The other agent said it works" | Verify before trusting. Check the code, run the test |
| "We already discussed this" | Discussion is not approval. Point to the explicit approval message |
| "I'll clean up the proposal later" | Write it properly the first time |

## Escalation

First violation after this rule is in place triggers structural enforcement — proposal message types with approval gates.
