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

// handovers: clean orphan temps, archive resolved (>24h) and stale open (>30d), then
// report from one post-archive scan. A failure prints the scan-failed line and the
// hook carries on. See lib/maintenance.js (B, C, C2) and lib/handover.js.
try {
  const maintenance = require(path.join(ROOT, 'lib', 'maintenance.js'));
  const now = Date.now();
  maintenance.cleanupHandoverTemps(runsRoot, now);
  let pre = maintenance.scanItems(runsRoot, now);
  const resolved = maintenance.archiveResolvedHandovers(runsRoot, now, { items: pre.items });
  const stale = maintenance.archiveStaleOpenHandovers(runsRoot, now, { items: pre.items });
  if (resolved.moved + stale.moved > 0) pre = maintenance.scanItems(runsRoot, now);
  const scan = maintenance.scanHandovers(runsRoot, now, pre);
  if (scan.error && scan.error !== 'ENOENT') {
    process.stdout.write(`[advisor] handover scan failed: ${scan.error}\n`);
  } else {
    const top = scan.newestOpen;
    if (top) {
      const ageMs = now - top.createdMs;
      const ageDays = Math.floor(ageMs / 86400000);
      process.stdout.write(ageMs > maintenance.STALE_WARN_S * 1000
        ? `[advisor] STALE handover (${ageDays}d old): ${top.path} - resolve with bin/handover-resolve (auto-archives after 30d)\n`
        : `[advisor] OPEN handover: ${top.path}\n`);
    }
    if (scan.openCount >= 2 || scan.staleCount >= 1) {
      process.stdout.write(`[advisor] open handovers: ${scan.openCount} (${scan.staleCount} stale >7d)\n`);
    }
    if (resolved.moved > 0) process.stdout.write(`[advisor] archived ${resolved.moved} resolved handover(s)\n`);
    if (stale.moved > 0) {
      process.stdout.write(`[advisor] archived ${stale.moved} stale open handover(s) (unresolved >30d) to plans/_archive\n`);
    }
    if (scan.invalid.length > 0) {
      const shown = scan.invalid.slice(0, 5).map((i) => `${i.name} (${i.reason})`);
      const more = scan.invalid.length > 5 ? `, +${scan.invalid.length - 5} more` : '';
      process.stdout.write(`[advisor] INVALID handover file(s) (${scan.invalid.length}): ${shown.join(', ')}${more} - fix or remove by hand\n`);
    }
    const failed = resolved.failed.concat(stale.failed);
    if (failed.length > 0) {
      process.stdout.write(`[advisor] handover archive failed (${failed.length}): ${failed.map((f) => `${f.name}: ${f.code}`).join(', ')}\n`);
    }
  }
} catch (e) {
  process.stdout.write(`[advisor] handover scan failed: ${(e && e.code) || (e && e.message) || 'unknown'}\n`);
}

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
