---
name: synth
description: Record a synthesis checkpoint via channel.js synthesize with required fields: sid, seq, established, and gap. Use when the Advisor needs to log what has been established and what open question remains at a given session step.
last_edited: 2026-10-06
---

# Synth

Record a synthesis checkpoint via `channel.js synthesize`. `$ADV` must be set
(`bin/summon` exports it in worker environments; elsewhere use the repo root).
`channel.js` exits 1 naming any missing required flag, so run it only once you
have all six.

## Fields

| Flag | Required | Description |
|------|----------|-------------|
| `--sid` | yes | Session ID of the current advisor run |
| `--seq` | yes | Sequence number of the synthesis record |
| `--established` | yes | What has been established (one sentence) |
| `--gap` | yes | What gap or open question remains |
| `--material` | yes | `yes`, `no` or `partial`: whether supporting material is attached |
| `--next` | yes | `proceed-to-step-8`, `spawn-refinement: <gap>` or `spawn-evaluator` |
| `--key-quotes` | no | 1-2 verbatim quotes worth preserving; empty string if none |

## Invocation

```bash
bun "$ADV/lib/channel.js" synthesize \
  --sid "<sid>" --seq "<seq>" \
  --established "<established>" \
  --gap "<gap>" \
  --material "<material>" \
  --next "<next>" \
  --key-quotes "<key_quotes>"
```

## Usage example

```
/synth \
  --sid "1777470000-abc123" --seq "3" \
  --established "Both researchers confirm the API rate-limits at 60 req/min" \
  --gap "No consensus yet on which caching strategy to adopt" \
  --material "no" --next "proceed-to-step-8"
```
