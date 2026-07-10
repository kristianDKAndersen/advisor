# AGENTS.md Frontmatter Schema

## Purpose

Every `AGENTS.md` file in the advisor repository must begin with a YAML frontmatter block. This block makes the file machine-checkable: a linter can detect missing or malformed metadata without reading the body, and the doc-agent can populate and update fields automatically during synthesis. The schema is intentionally minimal (Decision 3 Option A) — three required fields capture provenance and scope without imposing structure that breaks hand-authoring.

The frontmatter convention is adapted from the [dox](https://github.com/agent0ai/dox) project and extended with advisor-specific provenance fields (`last_updated_by`, `last_updated_ts`) that link each `AGENTS.md` entry to the synthesis session that last established its content.

---

## Field Reference

| Field | Type | Required | Format | Example |
|-------|------|----------|--------|---------|
| `scope` | string | yes | Free-text description of what files or subsystem this `AGENTS.md` covers | `"lib/vault.js and lib/channel.js — vault read/write API and synthesis flow"` |
| `last_updated_by` | string | yes | `sid:<sid> seq:<seq>` — the synthesis session ID and sequence number that last wrote this file | `"sid:1781300677-a8c0ba seq:3"` |
| `last_updated_ts` | string | yes | ISO 8601 UTC timestamp of the last update | `"2026-06-12T14:30:00Z"` |
| `owners` | string or list | no | Free-text label or list of labels identifying the team or individual responsible | `"advisor-core"` or `["advisor-core", "doc-agent"]` |
| `key_interfaces` | list | no | List of `{name, file}` objects naming the primary exported functions or entry points | `[{name: "synthesize", file: "lib/channel.js"}]` |

### Field details

**`scope`** — Describes what this `AGENTS.md` covers: the files, directory, or conceptual subsystem. Free-text; no glob patterns required. Write it as a short phrase that would orient an agent reading this file cold. Example: `"lib/ directory — all advisor runtime modules"` or `"spawns/coder/ — coder worker spawn definition and permissions"`.

**`last_updated_by`** — References the advisor synthesis session that last updated this file. The format is exactly `sid:<sid> seq:<seq>` with a single space separator; no other characters. The `<sid>` is the session ID (a timestamp-hash string, e.g. `1781300677-a8c0ba`) and `<seq>` is the integer sequence number of the synthesis record. The doc-agent populates this field automatically; hand-authored files should use `sid:manual seq:0` when no synthesis session applies.

**`last_updated_ts`** — ISO 8601 timestamp in UTC. Must include at minimum date and time to second precision with a `Z` suffix: `YYYY-MM-DDTHH:MM:SSZ`. Millisecond precision (`YYYY-MM-DDTHH:MM:SS.mmmZ`) is accepted. The doc-agent populates this from the synthesis record's timestamp; hand-authored files should use the wall-clock time of the edit.

**`owners`** (optional) — A label or list of labels identifying who is responsible for keeping this `AGENTS.md` current. No enforced vocabulary; the value is informational only.

**`key_interfaces`** (optional) — A list of objects, each with `name` (exported symbol or CLI command) and `file` (repo-relative path). Useful for directories with many files where an agent needs to quickly locate the primary entry points. Example:

```yaml
key_interfaces:
  - name: synthesize
    file: lib/channel.js
  - name: provisionCoderWorktree
    file: lib/summon.js
```

---

## Body Conventions

The frontmatter block is followed by a Markdown body describing the directory's current state. Two rules govern body content regardless of who wrote it (human or doc-agent):

### Liveness rule — current state only

The body must reflect the current state of the code. Do not include changelogs, revision history, "previously this did X", or "added in session Y" commentary. Every statement must be true right now. When a subsystem changes, stale text must be removed, not annotated. An `AGENTS.md` that silently carries outdated claims is worse than no `AGENTS.md` at all.

### Parent-dominance rule — children may not weaken parent constraints

`AGENTS.md` files form a hierarchy: a root-level file sets constraints that apply to the entire repo; a `lib/AGENTS.md` refines those constraints for `lib/`; `lib/hooks/AGENTS.md` refines further for that subdirectory. A child file may add specifics or tighten constraints but must not contradict or relax constraints declared by any ancestor. For example: if the root `AGENTS.md` says "all writes to `lib/` require a paired test", a child `lib/hooks/AGENTS.md` cannot say "hooks are exempt from paired tests". If a child needs an exception, update the parent.

---

## Complete Valid Example

The following is a complete, valid `AGENTS.md` for a hypothetical `lib/` directory:

```markdown
---
scope: "lib/ directory — advisor runtime modules including channel, vault, summon, and hooks"
last_updated_by: "sid:1781300677-a8c0ba seq:3"
last_updated_ts: "2026-06-12T14:30:00Z"
owners: "advisor-core"
key_interfaces:
  - name: synthesize
    file: lib/channel.js
  - name: provisionCoderWorktree
    file: lib/summon.js
  - name: writeSynthesisNote
    file: lib/vault.js
---

# lib/

Runtime modules for the advisor framework. All modules run in Bun unless noted.

## channel.js

Append-only JSONL channel protocol. Exports `send`, `recv`, `tail`, and `synthesize`. The `synthesize` command writes a synthesis note to the vault (via `lib/vault.js`) and appends a doc-queue entry (via `lib/doc-queue.js`). Session-level locking uses mkdir spinlocks with stale-lock recovery for hard-killed processes.

## summon.js

Provisions worker sessions: composes bootstrap prompts, writes `launch.sh`, and opens a Terminal tab. Coder agents receive a git worktree (branch `ws/<sid>`); all other agents receive a plain directory copy. `injectWorkerHooks()` unconditionally injects PostToolUse/SessionStart/Stop hooks for all agent types and sets `ADVISOR_WORKER_HOOKS=1` in the worker environment — there is no allowlist; every summoned worker receives the trace/inbox-poll/auto-close hooks.

## vault.js

Native vault writer with FTS5 full-text search. Writes synthesis notes and session notes keyed by `sid-seq`. Bun-only (uses Bun SQLite bindings directly).

## hooks/

PostToolUse worker hooks: `worker-trace.js` (tool call tracing), `worker-inbox-poll.sh` (inbox polling between actions), `worker-auto-close.sh` (self-terminate on `terminate` message), and `agents-md-lint.js` (AGENTS.md frontmatter validation, also registered as a PreCompact hook).

## Constraints

- All modules in this directory must be tested in `tests/` before merging.
- New Bun-only APIs must be gated with a Bun availability check so Node.js callers fail fast with a clear error rather than a cryptic runtime failure.
- Hooks in `hooks/` must be idempotent — they fire on every tool use and must not corrupt state if called repeatedly with the same input.
```

---

## Lint Rules

A validator enforcing this schema must check the following conditions. Any violation must produce a non-zero exit code and a message identifying the file and the specific rule broken.

### LR-1 — Missing frontmatter block

**Condition:** The file does not begin with `---` on line 1.

**Message:** `<file>: missing YAML frontmatter block — file must begin with ---`

**Rationale:** A file that skips frontmatter entirely cannot be validated for any field. This is the first check; subsequent rules only apply if frontmatter is present.

---

### LR-2 — Missing required field: `scope`

**Condition:** The frontmatter block is present but does not contain a `scope` key, or the `scope` value is empty or whitespace-only.

**Message:** `<file>: missing required frontmatter field: scope`

---

### LR-3 — Missing required field: `last_updated_by`

**Condition:** The frontmatter block is present but does not contain a `last_updated_by` key, or the value is empty or whitespace-only.

**Message:** `<file>: missing required frontmatter field: last_updated_by`

---

### LR-4 — Missing required field: `last_updated_ts`

**Condition:** The frontmatter block is present but does not contain a `last_updated_ts` key, or the value is empty or whitespace-only.

**Message:** `<file>: missing required frontmatter field: last_updated_ts`

---

### LR-5 — Malformed `last_updated_by`

**Condition:** The `last_updated_by` value does not match the pattern `sid:<sid> seq:<seq>` where `<sid>` is one or more non-whitespace characters and `<seq>` is one or more digits. The exact regex is: `^sid:\S+ seq:\d+$`.

**Accepted examples:** `sid:1781300677-a8c0ba seq:3`, `sid:manual seq:0`

**Rejected examples:** `sid:abc`, `1781300677-a8c0ba seq:3` (missing `sid:` prefix), `sid:abc seq:three` (`seq` must be digits), `sid:abc  seq:1` (double space)

**Message:** `<file>: malformed last_updated_by — expected format: sid:<sid> seq:<seq>`

---

### LR-6 — Malformed `last_updated_ts`

**Condition:** The `last_updated_ts` value does not conform to ISO 8601 UTC format. Required: date and time to at least second precision, ending with `Z`. The exact regex is: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`.

**Accepted examples:** `2026-06-12T14:30:00Z`, `2026-06-12T14:30:00.123Z`

**Rejected examples:** `2026-06-12` (date only), `2026-06-12T14:30:00` (missing Z), `2026-06-12 14:30:00Z` (space instead of T), `2026-06-12T14:30Z` (missing seconds)

**Message:** `<file>: malformed last_updated_ts — expected ISO 8601 UTC format: YYYY-MM-DDTHH:MM:SSZ`

---

## Validator Behavior Summary

A conforming validator reads an `AGENTS.md` file from stdin (or as a path argument), applies rules LR-1 through LR-6 in order, and:

- Exits `0` with no output if all rules pass.
- Exits non-zero with one error message per violation (to stderr) if any rule fails.
- Stops after LR-1 if frontmatter is absent (subsequent rules cannot apply).
- Reports all remaining violations if frontmatter is present (does not stop at first field error).

The linter is implemented in `lib/hooks/agents-md-lint.js` and registered as a `PreCompact` hook in `.claude/settings.json` so it runs automatically before any transcript compaction that could destroy context about `AGENTS.md` state.
