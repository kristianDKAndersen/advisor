---
name: vault-due
description: Act on the SessionStart vault-due banner. Subcommands: done <note>, snooze <note> <days>, archive <note>.
last_edited: 2026-11-09
---

# vault-due

Act on notes that appear in the SessionStart vault-due banner. Run each command from the advisor repo root (`cd "${ADV:-.}"`; `$ADV` is set only in workers). `<note>` is the relative vault path (e.g. `lessons/1234-abc.md`); `<days>` is an integer.

## Subcommands

### `done <note>`

Mark a note as done - it leaves the due-date banner. Check the note's `type` first.

Other types:

```bash
bun -e "const {setStatus} = await import('./lib/vault.js'); setStatus('<note>', 'done')"
```

`type: lesson`: `setStatus` refuses done, so clear the due date instead:

```bash
bun -e "const {clearDueDate} = await import('./lib/vault.js'); clearDueDate('<note>')"
```

### `snooze <note> <days>`

Push the note's due date forward by `<days>` calendar days, counted from its current `due_date` (today if none).

```bash
bun -e "const {readNote, setDueDate} = await import('./lib/vault.js'); const n = readNote('<note>'); const b = n?.fm?.due_date ? new Date(n.fm.due_date) : new Date(); b.setDate(b.getDate() + <days>); setDueDate('<note>', b.toISOString().slice(0, 10))"
```

### `archive <note>`

Mark a note as archived - it leaves the due-date banner permanently. Check the note's `type` first.

Other types:

```bash
bun -e "const {setStatus} = await import('./lib/vault.js'); setStatus('<note>', 'archived')"
```

`type: lesson`: do not archive (`setStatus` refuses it, and archiving would hide the lesson from recall). Clear the due date as under `done`. To remove a lesson from recall, the Advisor runs `bun bin/advisor-vault lessons retire <note> --reason TEXT`.

Example: `/vault-due snooze lessons/1779957923-5750c3-researcher-1.md 7`
