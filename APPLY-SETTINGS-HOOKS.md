# Apply the two doc-agent settings hooks

The self-mod guard blocks the agent from editing `.claude/settings.json`, so these
two hook registrations must be applied by **you**. Both are reversible (git-tracked)
and take effect on the **next advisor session**.

What they do:
- **read-before-edit** (`agents-md-context.js`) — injects the nearest `AGENTS.md` as
  context before any Edit/Write in the advisor's own session.
- **commit-gate** (`agents-md-lint.js --commit-gate`) — lints any staged `AGENTS.md`
  on `git commit`, blocking malformed frontmatter.

---

## Option A — run it yourself (fastest)

Paste this at the Claude Code prompt with a leading `!` (runs in your shell, so the
self-mod guard does not apply). It is idempotent — safe to run twice.

```bash
node -e 'const fs=require("fs"),p=".claude/settings.json",s=JSON.parse(fs.readFileSync(p,"utf8"));const CTX="node $CLAUDE_PROJECT_DIR/lib/hooks/agents-md-context.js",GATE="node $CLAUDE_PROJECT_DIR/lib/hooks/agents-md-lint.js --commit-gate";s.hooks=s.hooks||{};const pt=s.hooks.PreToolUse=s.hooks.PreToolUse||[],has=c=>pt.some(b=>(b.hooks||[]).some(h=>h.command===c));let ew=pt.find(b=>b.matcher==="Edit|Write");if(!ew){ew={matcher:"Edit|Write",hooks:[]};pt.push(ew)}if(!has(CTX))ew.hooks.push({type:"command",command:CTX});if(!has(GATE))pt.push({matcher:"Bash",hooks:[{type:"command",command:GATE}]});fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");console.log("context hook:",has(CTX),"| commit gate:",has(GATE))'
```

Expected output: `context hook: true | commit gate: true`

Then commit:

```bash
c
```

---

## Option B — let the agent do it

Grant a standing permission for `.claude/settings.json` (via `/permissions`, or add a
rule allowing edits to that file), then tell the advisor "apply the settings hooks"
and it will make the edit + commit directly.

---

## Manual fallback — paste the JSON

If you prefer to edit `.claude/settings.json` by hand, the `PreToolUse` array should
contain these two blocks (add the second hook to the existing `Edit|Write` block, and
add the `Bash` block):

```json
"PreToolUse": [
  {
    "matcher": "Edit|Write",
    "hooks": [
      { "type": "command", "command": "node $CLAUDE_PROJECT_DIR/.claude/hooks/workspace-guard.js" },
      { "type": "command", "command": "node $CLAUDE_PROJECT_DIR/lib/hooks/agents-md-context.js" }
    ]
  },
  {
    "matcher": "Bash",
    "hooks": [
      { "type": "command", "command": "node $CLAUDE_PROJECT_DIR/lib/hooks/agents-md-lint.js --commit-gate" }
    ]
  }
]
```

After this, branch `feature/doc-agent` is fully merge-ready.
