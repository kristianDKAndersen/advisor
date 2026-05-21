#!/usr/bin/env node
// SessionStart hook — ensures .advisor-runs/ exists and prints a banner with
// the available agents. Runs once at the start of each Claude Code session
// in the advisor project.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(ROOT, '.advisor-runs'), { recursive: true });

const agentsDir = path.join(ROOT, 'spawns');
let agents = [];
if (fs.existsSync(agentsDir)) {
  agents = fs
    .readdirSync(agentsDir)
    .filter((n) => fs.existsSync(path.join(agentsDir, n, 'CLAUDE.md')));
}

process.stdout.write(
  `[advisor] ready · agents: ${agents.length ? agents.join(', ') : '(none — add one in spawns/)'}\n`
);

const runsRoot = process.env.ADVISOR_RUNS_ROOT || path.join(os.homedir(), '.advisor', 'runs');
if (fs.existsSync(runsRoot)) {
  const runs = fs.readdirSync(runsRoot)
    .map(d => ({ sid: d, mtime: fs.statSync(path.join(runsRoot, d)).mtimeMs }))
    .filter(r => Date.now() - r.mtime < 86_400_000)
    .sort((a, b) => b.mtime - a.mtime);
  if (runs.length > 0) {
    const sessionFile = path.join(runsRoot, runs[0].sid, 'session.json');
    if (fs.existsSync(sessionFile)) {
      try {
        const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        const pending = (s.decomposition || []).filter(d => d.status !== 'complete').length;
        process.stdout.write(
          `[advisor] last session: ${runs[0].sid} | tier: ${s.tier || 'unknown'} | ` +
          `next: ${s.next_action || 'none'} | pending workers: ${pending}\n`
        );
      } catch (_) {}
    }
  }
}
