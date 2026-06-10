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

// last session: newest run dir with a valid session.json, skipping plans/_archive
// and dirs lacking one (graceful no-op on failure). See lib/maintenance.js (A).
try {
  const maintenance = require(path.join(ROOT, 'lib', 'maintenance.js'));
  const picked = maintenance.pickLastSession(runsRoot);
  if (picked) {
    const s = picked.session;
    const pending = (s.decomposition || []).filter(d => d.status !== 'complete').length;
    process.stdout.write(
      `[advisor] last session: ${picked.sid} | tier: ${s.tier || 'unknown'} | ` +
      `next: ${s.next_action || 'none'} | pending workers: ${pending}\n`
    );
  }
} catch (_) {}

// surface the newest UNRESOLVED handover, if any (graceful no-op). See maintenance (B).
try {
  const maintenance = require(path.join(ROOT, 'lib', 'maintenance.js'));
  const open = maintenance.newestUnresolvedHandover(runsRoot);
  if (open) process.stdout.write(`[advisor] OPEN handover: ${open}\n`);
} catch (_) {}

// auto-archive resolved handovers older than 24h (graceful no-op). See maintenance (C).
try {
  const maintenance = require(path.join(ROOT, 'lib', 'maintenance.js'));
  const n = maintenance.archiveResolvedHandovers(runsRoot);
  if (n > 0) process.stdout.write(`[advisor] archived ${n} resolved handover(s)\n`);
} catch (_) {}

// auto-archive vault reminders >30d past due (status flip + index update; graceful
// no-op). vault.js loads bun:sqlite, which throws under node — so run it under bun,
// mirroring the vault-due block below. See maintenance (D).
try {
  const { spawnSync } = require('child_process');
  const expr = `require(${JSON.stringify(path.join(ROOT, 'lib', 'maintenance.js'))})` +
    `.archiveStaleReminders(require(${JSON.stringify(path.join(ROOT, 'lib', 'vault.js'))}))`;
  spawnSync('bun', ['-e', expr], { encoding: 'utf8', timeout: 5000 });
} catch (_) {}

// Surface vault notes due within the next 14 days (graceful no-op on failure)
try {
  const { spawnSync } = require('child_process');
  const vaultBin = path.join(ROOT, 'bin', 'advisor-vault');
  const result = spawnSync('bun', [vaultBin, 'due', '--window', '14'], {
    encoding: 'utf8', timeout: 5000,
  });
  const out = (result.stdout || '').trim();
  if (out && out !== '(no due notes)') {
    process.stdout.write(
      `[advisor] vault due (next 14d):\n${out.split('\n').map(l => '  ' + l).join('\n')}\n`
    );
  }
} catch (_) {}
