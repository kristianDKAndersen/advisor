#!/usr/bin/env node
// SessionStart hook — ensures .advisor-runs/ exists and prints a banner with
// the available agents. Runs once at the start of each Claude Code session
// in the advisor project.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(ROOT, '.advisor-runs'), { recursive: true });

const agentsDir = path.join(ROOT, 'agents');
let agents = [];
if (fs.existsSync(agentsDir)) {
  agents = fs
    .readdirSync(agentsDir)
    .filter((n) => fs.existsSync(path.join(agentsDir, n, 'CLAUDE.md')));
}

process.stderr.write(
  `[advisor] ready · agents: ${agents.length ? agents.join(', ') : '(none — add one in agents/)'}\n`
);
