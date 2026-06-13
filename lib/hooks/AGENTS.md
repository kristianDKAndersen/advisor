---
scope: "lib/hooks/ — Claude Code PreToolUse/PostToolUse hook scripts for the advisor repo"
last_updated_by: "sid:1781304001-e1ba49 seq:3"
last_updated_ts: "2026-06-13T00:00:00Z"
---

# lib/hooks/

Hook scripts executed by the Claude Code harness on tool events.

## agents-md-lint.js

Validates AGENTS.md files against linting rules LR-1 through LR-6.

- `parseFrontmatter(content)` — extracts YAML frontmatter fields from a `---`-delimited block
- `lint(content, filename)` — checks: LR-1 frontmatter block present, LR-2 `scope` field present, LR-3/LR-5 `last_updated_by` present and matches `sid:<sid> seq:<seq>`, LR-4/LR-6 `last_updated_ts` present and matches ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`)
- `commitGate()` — PreToolUse[Bash] mode: reads tool input JSON from stdin, exits non-zero if a `git commit` command has staged AGENTS.md files with lint violations

Intended hook registration (not yet in settings.json due to self-modification classifier block):
```
PreToolUse matcher: Bash
Command: node $CLAUDE_PROJECT_DIR/lib/hooks/agents-md-lint.js --commit-gate
```

Run standalone as `node lib/hooks/agents-md-lint.js --file <path>` to validate a single file (exit 0 = pass).
