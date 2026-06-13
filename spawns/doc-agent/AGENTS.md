---
scope: "spawns/doc-agent/ — definition and configuration for the doc-agent spawn"
last_updated_by: "sid:1781304118-fd6647 seq:3"
last_updated_ts: "2026-06-13T15:15:44Z"
---

# spawns/doc-agent/

Contains the CLAUDE.md definition and Claude Code settings for the doc-agent, a focused documentation worker summoned by the Advisor.

## CLAUDE.md

The doc-agent prompt and protocol:

- Reads unprocessed entries from `~/.advisor/doc-queue.jsonl` via `lib/doc-queue.js`
- Phase 1–5 workflow: load queue → read ancestor AGENTS.md files → graphify context → write/update AGENTS.md → mark processed
- Phase 2.5: if `$REPO/graphify-out/graph.json` exists, runs `graphify explain <node>` and `graphify path A B` to add graph-grounded cross-reference lines; absent graph = skip phase entirely; graph results are ADDITIVE ONLY — never write `unused` or `dead` claims based on graph output
- All repo file reads/writes use absolute `$REPO/`-prefixed paths (never relative)
- Frontmatter schema enforced: `scope`, `last_updated_by` (`sid:<sid> seq:<seq>`), `last_updated_ts` (ISO 8601 UTC)

## .claude/skills/graphify/

Agent-private graphify skill bundle vendored here and merged into the worker's Claude config at summon time via `lib/summon.js:501-534`. Not present in the repo-level `.claude/skills/`.
