// Tests for bin/handover-resolve — the deterministic mechanism that marks a
// context-handover file (written by .claude/skills/pre-compact/SKILL.md) as
// resolved by appending a `FINAL OUTCOME: <text>` line, so lib/maintenance.js's
// RESOLVED_RE check (and therefore newestUnresolvedHandover / session-start.js's
// OPEN-handover banner) picks it up mechanically instead of relying on someone
// remembering to type the marker.
import { test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BIN = path.resolve(import.meta.dir, '../bin/handover-resolve');

test('handover-resolve appends FINAL OUTCOME so maintenance excludes it from open handovers; unresolved sibling stays open', async () => {
  const maintenance = await import('../lib/maintenance.js');
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'hres-runs-'));
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });

  const target = path.join(plans, 'handover-target.md');
  const sibling = path.join(plans, 'handover-sibling.md');
  fs.writeFileSync(target, '# Context handover\n\nsome raw session dump, no outcome yet\n');
  fs.writeFileSync(sibling, '# Context handover\n\nstill open, untouched\n');

  // both start unresolved
  expect(maintenance.listHandovers(runs).every((h) => !h.resolved)).toBe(true);

  const r = spawnSync('bun', [BIN, target, '--outcome', 'completed by session xyz'], { encoding: 'utf8' });
  expect(r.status).toBe(0);

  const content = fs.readFileSync(target, 'utf8');
  expect(content).toMatch(/FINAL OUTCOME: completed by session xyz/i);

  const statuses = maintenance.listHandovers(runs).reduce((m, h) => (m[h.name] = h.resolved, m), {});
  expect(statuses['handover-target.md']).toBe(true);
  expect(statuses['handover-sibling.md']).toBe(false);

  const open = maintenance.newestUnresolvedHandover(runs);
  expect(open).toBe(sibling);

  fs.rmSync(runs, { recursive: true, force: true });
});

test('handover-resolve refuses to double-resolve an already-resolved handover', () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'hres-runs2-'));
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const f = path.join(plans, 'handover-done.md');
  fs.writeFileSync(f, 'wrapped up.\n\nFINAL OUTCOME: already done');

  const r = spawnSync('bun', [BIN, f, '--outcome', 'again'], { encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(fs.readFileSync(f, 'utf8').match(/FINAL OUTCOME/gi).length).toBe(1);

  fs.rmSync(runs, { recursive: true, force: true });
});

test('handover-resolve requires an existing file and an --outcome value', () => {
  const missing = spawnSync('bun', [BIN, '/tmp/definitely-not-a-real-handover-file.md', '--outcome', 'x'], { encoding: 'utf8' });
  expect(missing.status).not.toBe(0);

  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'hres-runs3-'));
  const f = path.join(runs, 'handover-noflag.md');
  fs.writeFileSync(f, 'open');
  const noOutcome = spawnSync('bun', [BIN, f], { encoding: 'utf8' });
  expect(noOutcome.status).not.toBe(0);
  expect(fs.readFileSync(f, 'utf8')).toBe('open');

  fs.rmSync(runs, { recursive: true, force: true });
});
