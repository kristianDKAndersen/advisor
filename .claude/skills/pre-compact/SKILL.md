---
name: pre-compact
description: Pre-flight checklist for manual /compact — writes a context-handover file to ~/.advisor/runs/plans/ and commits a checkpoint. Run this BEFORE issuing /compact. Required because GH#13572 — PreCompact does not fire on manual /compact, so the auto-save hook is bypassed.
last_edited: 2026-11-04
allowed-tools:
  - Bash
---

# pre-compact

Pre-flight for manual `/compact`: run steps 1-3 from the advisor repo root, in order, before issuing `/compact`. The PreCompact hook covers only automatic compaction (GH#13572), so a manual `/compact` otherwise discards unsaved session state.

## Steps

### 1. Write the handover file

Pass your active `<sid>` with `--sid` when you know it; put next_action, per-worker synthesis_seq and open decisions in the notes on stdin:

```bash
bin/handover-write --sid <sid> <<'NOTES'
next_action: <what the successor does first>
workers: <sid>=synthesis_seq <n>, ...
NOTES
```

It writes `~/.advisor/runs/plans/<YYYYMMDD-HHMMSS>-context-handover.md` with a `status: open` header, the session state and your notes, and prints the absolute path. Without `--sid` it falls back to `$ADVISOR_SID`, then the newest run dir, and reports the choice on stderr. Exit 2 = no session.json for the sid; nothing is written. `session-start.js` surfaces the file on the next session start. **Do NOT issue `/compact` before this step completes - the sid is lost otherwise.**

### 2. Commit a checkpoint

```bash
git add -A && git commit --no-verify -m "manual-compact: checkpoint"
```

`git add -A` is intentional here: this is a dedicated checkpoint commit, one of the documented places in this repo where it is acceptable.

### 3. Issue /compact

## Recovery

On the next session start, read the handover path `session-start.js` surfaces (OPEN, or STALE when older than 7 days) and restore state from the session snapshot in that file without re-parsing the channel history.

The handover's `status` header is `open` (surfaced at every session start) until a later session finishes the handed-over work. An open handover untouched for 30 days (counted from the later of `created` and its last edit) is auto-archived to `plans/_archive` with `archive_reason: stale-30d`; a resolved one is archived after 24 hours. Once the work is verifiably done, resolve it - do not hand-edit the header or type a `FINAL OUTCOME:` line, and do not resolve at write time:

```bash
bin/handover-resolve <path-to-handover-file> --outcome "<one-line summary of what got completed>"
```

It sets `status: resolved` in the header. Exit 4 = already resolved (nothing changed); exit 2 = invalid file or missing `--outcome`; exit 3 = symlink refused. A malformed, unreadable or long-empty handover is listed as `INVALID` at session start and is never auto-archived: fix or remove it by hand.
