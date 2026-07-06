---
name: pre-compact
description: Pre-flight checklist for manual /compact — writes a context-handover file to ~/.advisor/runs/plans/ and commits a checkpoint. Run this BEFORE issuing /compact. Required because GH#13572 — PreCompact does not fire on manual /compact, so the auto-save hook is bypassed.
allowed-tools:
  - Bash
---

# pre-compact

Pre-flight for manual `/compact`. Run these steps in order before issuing `/compact`.

## Why this is needed

The PreCompact hook in `.claude/settings.json` auto-commits a checkpoint (`git add -A && git commit --no-verify -m "auto-save: pre-compaction checkpoint"`) — but only for automatic compaction. **GH#13572: PreCompact does not fire on manual `/compact`.** Without this skill, manually issuing `/compact` discards unsaved session state. The Stop hook fires after every response, so it covers some of this path — but running this skill explicitly is the reliable guarantee.

## Steps

### 1. Dump session state to disk

```bash
node -e "
  const {readSessionState} = require('./lib/session');
  readSessionState('<sid>').then(s => console.log(JSON.stringify(s, null, 2)));
"
```

Substitute your active `<sid>`. The output includes `tier`, `decomposition[]` statuses, `next_action`, and `synthesis_seq` for each worker.

### 2. Write the handover file

```bash
node -e "
  const {readSessionState} = require('./lib/session');
  const fs = require('fs');
  const path = require('path');
  readSessionState('<sid>').then(s => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(process.env.HOME, '.advisor/runs/plans', ts + '-context-handover.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(s, null, 2));
    console.log('wrote', out);
  });
"
```

Alternatively, capture session state as text and write it manually:

```bash
TS=$(date +%Y%m%d-%H%M%S)
HANDOVER="$HOME/.advisor/runs/plans/${TS}-context-handover.md"
mkdir -p "$HOME/.advisor/runs/plans"
node -e "const {readSessionState}=require('./lib/session');readSessionState('<sid>').then(s=>process.stdout.write(JSON.stringify(s,null,2)))" > "$HANDOVER"
echo "Wrote $HANDOVER"
```

The `session-start.js` hook surfaces the last handover on the next session start. **Do NOT issue `/compact` before completing this step — the sid is lost after `/compact` if it is not written to disk.**

### 3. Commit a checkpoint

```bash
git add -A && git commit --no-verify -m "manual-compact: checkpoint"
```

Note: `git add -A` is intentional here — this is a dedicated checkpoint commit, not a feature commit. It is one of the documented places in this repo where `git add -A` is acceptable.

### 4. Issue /compact

Now issue `/compact`. The handover file and the checkpoint commit ensure the session is fully recoverable.

## Recovery

On the next session start, `session-start.js` surfaces the last handover file path. Read it and call `readSessionState(sid)` to restore `tier`, `decomposition[]`, `next_action`, and `synthesis_seq` without re-parsing the full channel history.

A handover written by step 2 is unresolved by design — the work it describes isn't done yet, it's about to be interrupted by `/compact`. It stays OPEN (surfaced by `session-start.js` on every subsequent session start, per `lib/maintenance.js`'s `RESOLVED_RE` check) until a *later* session actually finishes the handed-over work.

### Resolving a handover

Once a successor session (this one, resumed, or a later one) has completed the work the handover describes, mark it resolved mechanically — don't hand-type a `FINAL OUTCOME:` line, since a remembered marker is exactly the kind of artifact that gets forgotten:

```bash
bin/handover-resolve <path-to-handover-file> --outcome "<one-line summary of what got completed>"
```

This appends `FINAL OUTCOME: <text>` to the file. `lib/maintenance.js`'s `newestUnresolvedHandover()` (and therefore the `session-start.js` OPEN-handover banner) will stop surfacing it, and `archiveResolvedHandovers()` will move it to `plans/_archive/` after 24h. Run it as soon as the handover's work is verifiably done — not at write time in step 2, since at that point the work is still pending.
