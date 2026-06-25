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
