---
name: vault-due
description: Act on the SessionStart vault-due banner. Subcommands: done <note>, snooze <note> <days>, archive <note>.
---

# vault-due

Act on notes that appear in the SessionStart vault-due banner. Run all commands from `$ADV` (the advisor repo root).

## Subcommands

### `done <note>`

Mark a note as done — removes it from future due-date banners.

```bash
bun -e "const {setStatus} = await import('./lib/vault.js'); setStatus('<note>', 'done')"
```

Replace `<note>` with the relative vault path (e.g. `lessons/1234-abc.md`).

### `snooze <note> <days>`

Push the note's due date forward by `<days>` calendar days.

```bash
bun -e "const {readNote, setDueDate} = await import('./lib/vault.js'); const n = readNote('<note>'); const b = n?.fm?.due_date ? new Date(n.fm.due_date) : new Date(); b.setDate(b.getDate() + <days>); setDueDate('<note>', b.toISOString().slice(0, 10))"
```

Replace `<note>` with the relative vault path and `<days>` with an integer number of days.

### `archive <note>`

Mark a note as archived — suppresses it from due-date banners permanently.

```bash
bun -e "const {setStatus} = await import('./lib/vault.js'); setStatus('<note>', 'archived')"
```

Replace `<note>` with the relative vault path.

## Usage examples

```
/vault-due done lessons/1779957923-5750c3-researcher-1.md
/vault-due snooze lessons/1779957923-5750c3-researcher-1.md 7
/vault-due archive lessons/1779957923-5750c3-researcher-1.md
```

## Notes

- All three commands update both the file frontmatter and the SQLite vault index.
- `done` and `archived` notes are excluded from `listDue` output; they will not reappear in the banner.
- Snooze computes the new date relative to the note's current `due_date`, or today if none is set.
