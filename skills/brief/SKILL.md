---
name: brief
description: Compose a validated bin/summon command for a worker agent with all 5 required fields: objective, output, tools, scope, and parallelism. Use when the Advisor needs to launch a new worker via bin/summon and wants to ensure the brief is complete before invocation.
---

# Brief

Compose and emit a validated `bin/summon` command for a worker agent.
All 5 required fields must be supplied; missing fields cause a usage error
without emitting any command.

## Required fields

| Flag | Description |
|------|-------------|
| `--objective` | What the worker must accomplish (one sentence) |
| `--output` | The concrete deliverable(s) the worker must produce |
| `--tools` | Comma-separated list of tools the worker may use |
| `--scope` | What is explicitly OUT of scope for this worker |
| `--parallelism` | Whether this worker runs in parallel with others (yes/no + rationale) |

## Validation

Before emitting any command, check that **all 5 fields** are non-empty.
If any field is missing, print:

```
ERROR: missing required field: --<field>
Usage: /brief --objective "..." --output "..." --tools "..." --scope "..." --parallelism "..."
```

Do NOT emit a `bin/summon` command when any field is missing.

## Invocation (all 5 fields present)

When all 5 fields are supplied, emit the following command (substituting
each `<…>` with the corresponding field value):

```bash
bin/summon --agent <agent> \
  --task "<objective>. Output: <output>. Tools: <tools>. Out of scope: <scope>. Parallelism: <parallelism>." \
  --goal "<output>"
```

The `<agent>` value should be chosen based on the objective (e.g., `researcher`,
`coder`, `creative`, `evaluator`). If the agent type is ambiguous, default to
`researcher`.

## Usage example

```
/brief \
  --objective "Research the top 5 JavaScript bundlers and compare their cold-start performance" \
  --output "comparison-report.md with benchmark table" \
  --tools "WebSearch, WebFetch, Read, Write" \
  --scope "Do not implement any bundler changes or run benchmarks yourself" \
  --parallelism "yes — independent of all other workers in this session"
```

Emits:

```bash
bin/summon --agent researcher \
  --task "Research the top 5 JavaScript bundlers and compare their cold-start performance. Output: comparison-report.md with benchmark table. Tools: WebSearch, WebFetch, Read, Write. Out of scope: Do not implement any bundler changes or run benchmarks yourself. Parallelism: yes — independent of all other workers in this session." \
  --goal "comparison-report.md with benchmark table"
```
