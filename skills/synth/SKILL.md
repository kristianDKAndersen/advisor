---
name: synth
description: Record a synthesis checkpoint via channel.js synthesize with required fields sid, seq, established, gap, material and next. Use when the Advisor needs to log what has been established and what open question remains at a given session step.
last_edited: 2026-10-26
---

# Synth

Record a synthesis checkpoint via `channel.js synthesize`, from the advisor repo
root unless `$ADV` is set (`bin/summon` exports it only in workers).
`channel.js` exits 1 naming any missing required flag, so run it only once you
have all seven.

## Fields

| Flag | Required | Description |
|------|----------|-------------|
| `--sid` | yes | Session ID of the current advisor run |
| `--seq` | yes | Sequence number of the synthesis record |
| `--established` | yes | What has been established (one sentence) |
| `--gap` | yes | What gap or open question remains |
| `--material` | yes | `yes`, `no` or `partial`: whether the gap blocks acceptance (`yes` = Return per `claude.md` Step 7, `partial` = accept with the gap named as follow-up, `no` = accept) |
| `--next` | yes | `proceed-to-step-8`, `spawn-refinement: <gap>` or `spawn-evaluator` |
| `--integration-edits` | yes | `none`, or a `;`-separated list of every edit the Advisor made to worker output (`file:line what`); two of one kind across runs trigger Prompt self-repair |
| `--key-quotes` | no | 1-2 verbatim quotes worth preserving; empty string if none |

## Invocation

```bash
bun "${ADV:-.}/lib/channel.js" synthesize \
  --sid "<sid>" --seq "<seq>" \
  --established "<established>" \
  --gap "<gap>" \
  --material "<material>" \
  --next "<next>" \
  --integration-edits "<none, or file:line what; ...>" \
  --key-quotes "<key_quotes>"
```
