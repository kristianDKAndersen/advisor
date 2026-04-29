# /synth — Advisor synthesis skill

Run a synthesis record via `channel.js synthesize`. All 4 required fields must
be supplied; missing fields cause a validation error without invoking the command.

**Prerequisite:** `$ADV` must be set (it is exported by `bin/summon` in all
worker environments).

## Required fields

| Flag | Description |
|------|-------------|
| `--sid` | Session ID of the current advisor run |
| `--seq` | Sequence number of the synthesis record |
| `--established` | What has been established (one sentence) |
| `--gap` | What gap or open question remains |

## Optional fields

| Flag | Default | Description |
|------|---------|-------------|
| `--material` | `no` | Whether supporting material is attached (`yes`/`no`) |
| `--next` | `proceed-to-step-8` | Next action directive for the Advisor |

## Validation

Check all 4 required fields FIRST. If any is missing, print:

```
ERROR: missing required field: --<field>
Usage: /synth --sid "..." --seq "..." --established "..." --gap "..." [--material "no"] [--next "proceed-to-step-8"]
```

Do NOT invoke `node ... synthesize` when any required field is missing.

## Invocation (all required fields present)

```bash
node "$ADV/lib/channel.js" synthesize \
  --sid "<sid>" --seq "<seq>" \
  --established "<established>" \
  --gap "<gap>" \
  --material "<material>" \
  --next "<next>"
```

## Usage example

```
/synth \
  --sid "1777470000-abc123" \
  --seq "3" \
  --established "Both researchers confirm the API rate-limits at 60 req/min" \
  --gap "No consensus yet on which caching strategy to adopt"
```

Invokes:

```bash
node "$ADV/lib/channel.js" synthesize \
  --sid "1777470000-abc123" --seq "3" \
  --established "Both researchers confirm the API rate-limits at 60 req/min" \
  --gap "No consensus yet on which caching strategy to adopt" \
  --material "no" \
  --next "proceed-to-step-8"
```
