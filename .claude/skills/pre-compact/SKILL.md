---
name: pre-compact
description: Pre-flight checklist for manual /compact — writes a context-handover file to ~/.advisor/runs/plans/ and commits a checkpoint. Run this BEFORE issuing /compact. Required because GH#13572 — PreCompact does not fire on manual /compact, so the auto-save hook is bypassed.
last_edited: 2026-10-06
allowed-tools:
  - Bash
---

# pre-compact

Pre-flight for manual `/compact`: run steps 1-3 from the advisor repo root, in order, before issuing `/compact`. The PreCompact hook covers only automatic compaction (GH#13572), so a manual `/compact` otherwise discards unsaved session state.

## Steps

### 1. Write the handover file

Substitute your active `<sid>`:

```bash
node -e "
  const {readSessionState} = require('./lib/session');
  const fs = require('fs');
  const path = require('path');
  const s = readSessionState('<sid>');
  if (!s) { console.error('no session.json for <sid>'); process.exit(1); }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(process.env.HOME, '.advisor/runs/plans', ts + '-context-handover.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(s, null, 2));
  console.log('wrote', out);
"
```

The file holds `tier`, `decomposition[]` statuses, `next_action` and `synthesis_seq`; `session-start.js` surfaces it on the next session start. **Do NOT issue `/compact` before this step completes - the sid is lost otherwise.**

### 2. Commit a checkpoint

```bash
git add -A && git commit --no-verify -m "manual-compact: checkpoint"
```

`git add -A` is intentional here: this is a dedicated checkpoint commit, one of the documented places in this repo where it is acceptable.

### 3. Issue /compact

## Recovery

On the next session start, read the handover path `session-start.js` surfaces and call `readSessionState(sid)` to restore state without re-parsing the channel history.

The handover stays OPEN (surfaced at every session start, per `RESOLVED_RE` in `lib/maintenance.js`) until a later session finishes the handed-over work. Once the work is verifiably done, resolve it - do not hand-type a `FINAL OUTCOME:` line, and do not resolve at write time:

```bash
bin/handover-resolve <path-to-handover-file> --outcome "<one-line summary of what got completed>"
```
