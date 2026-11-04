// session-start hook: handover banner lines (plan D-d). Every spawn uses
// fs.mkdtempSync dirs for ADVISOR_RUNS_ROOT and ADVISOR_VAULT.
import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const HOOK = path.resolve(import.meta.dir, '..', '.claude', 'hooks', 'session-start.js');
const DAY = 86400;
const tmpDirs = [];

function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.chmodSync(path.join(d, 'plans'), 0o755); } catch (_) { /* no plans dir */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function setup() {
  const runs = mk('ss-hv-runs-');
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans);
  return { runs, plans };
}

function nowS() { return Math.floor(Date.now() / 1000); }

function writeHeadered(plans, name, { status = 'open', ageDays = 0, resolvedAgeDays = null, body = 'body\n' } = {}) {
  const created = nowS() - Math.round(ageDays * DAY);
  const resolved = resolvedAgeDays === null ? '' : String(nowS() - Math.round(resolvedAgeDays * DAY));
  const content = `---\nstatus: ${status}\ncreated: ${created}\nsid: s1\nresolved: ${resolved}\noutcome:\narchived:\narchive_reason:\n---\n${body}`;
  const p = path.join(plans, name);
  fs.writeFileSync(p, content);
  const t = new Date(created * 1000);
  fs.utimesSync(p, t, t);
  return p;
}

function writeLegacy(plans, name, content, ageDays = 0) {
  const p = path.join(plans, name);
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - ageDays * DAY * 1000);
  fs.utimesSync(p, t, t);
  return p;
}

function runHook(runs) {
  const vault = mk('ss-hv-vault-');
  const r = spawnSync('node', [HOOK], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: runs, ADVISOR_VAULT: vault },
    timeout: 20000,
  });
  const lines = (r.stdout || '').split('\n').filter((l) => l.startsWith('[advisor]'));
  return { status: r.status, out: r.stdout || '', lines };
}

const hv = (lines) => lines.filter((l) => /handover/.test(l));

test('prints OPEN line for newest fresh open handover', () => {
  const { runs, plans } = setup();
  writeHeadered(plans, 'a-handover.md', { ageDays: 2 });
  const p = writeHeadered(plans, 'b-handover.md', { ageDays: 1 });
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(hv(r.lines)).toContain(`[advisor] OPEN handover: ${p}`);
  expect(r.out).not.toContain('STALE handover');
});

test('prints STALE line with day count when newest open is older than 7d', () => {
  const { runs, plans } = setup();
  const p = writeHeadered(plans, 'old-handover.md', { ageDays: 10.5 });
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(hv(r.lines)).toContain(
    `[advisor] STALE handover (10d old): ${p} - resolve with bin/handover-resolve (auto-archives after 30d)`
  );
  expect(r.out).not.toContain('OPEN handover:');
  expect(hv(r.lines)).toContain('[advisor] open handovers: 1 (1 stale >7d)');
});

test('prints open-count line only when 2+ open or any stale', () => {
  const one = setup();
  writeHeadered(one.plans, 'x-handover.md', { ageDays: 1 });
  expect(runHook(one.runs).out).not.toContain('open handovers:');

  const two = setup();
  writeHeadered(two.plans, 'x-handover.md', { ageDays: 1 });
  writeHeadered(two.plans, 'y-handover.md', { ageDays: 2 });
  expect(hv(runHook(two.runs).lines)).toContain('[advisor] open handovers: 2 (0 stale >7d)');
});

test('archives open >30d and prints the stale-archived line; archived header has reason', () => {
  const { runs, plans } = setup();
  writeHeadered(plans, 'ancient-handover.md', { ageDays: 40 });
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(hv(r.lines)).toContain(
    '[advisor] archived 1 stale open handover(s) (unresolved >30d) to plans/_archive'
  );
  expect(fs.existsSync(path.join(plans, 'ancient-handover.md'))).toBe(false);
  const archived = fs.readFileSync(path.join(plans, '_archive', 'ancient-handover.md'), 'utf8');
  expect(archived).toMatch(/^archive_reason: stale-30d$/m);
  expect(r.out).not.toContain('OPEN handover:');
});

test('legacy resolved >24h still prints the resolved-archived line', () => {
  const { runs, plans } = setup();
  writeLegacy(plans, 'legacy-handover.md', '# h\nFINAL OUTCOME: done\n', 3);
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(hv(r.lines)).toContain('[advisor] archived 1 resolved handover(s)');
  expect(fs.existsSync(path.join(plans, '_archive', 'legacy-handover.md'))).toBe(true);
});

test('prints INVALID line naming malformed, unreadable and old-empty files with reasons, no OPEN line for them', () => {
  const { runs, plans } = setup();
  fs.writeFileSync(path.join(plans, 'bad-handover.md'), '---\nstatus: nope\ncreated: 1\n---\nx\n');
  fs.writeFileSync(path.join(plans, 'unclosed-handover.md'), '---\nstatus: open\ncreated: 1\nno close\n');
  const empty = path.join(plans, 'empty-handover.md');
  fs.writeFileSync(empty, '');
  const old = new Date(Date.now() - 120 * 1000);
  fs.utimesSync(empty, old, old);
  fs.symlinkSync(path.join(plans, 'bad-handover.md'), path.join(plans, 'link-handover.md'));
  const r = runHook(runs);
  expect(r.status).toBe(0);
  const line = hv(r.lines).find((l) => l.startsWith('[advisor] INVALID handover file(s) (4): '));
  expect(line).toBeDefined();
  expect(line).toContain('bad-handover.md (bad-status)');
  expect(line).toContain('unclosed-handover.md (unclosed-header)');
  expect(line).toContain('empty-handover.md (empty)');
  expect(line).toContain('link-handover.md (symlink)');
  expect(line.endsWith(' - fix or remove by hand')).toBe(true);
  expect(line).not.toContain('more');
  expect(r.out).not.toContain('OPEN handover:');
  expect(r.out).not.toContain('STALE handover');
});

test('young empty file is not reported', () => {
  const { runs, plans } = setup();
  fs.writeFileSync(path.join(plans, 'fresh-handover.md'), '');
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(r.out).not.toContain('INVALID');
});

test('lists at most 5 invalid names then +m more', () => {
  const { runs, plans } = setup();
  for (let i = 1; i <= 7; i++) {
    fs.writeFileSync(path.join(plans, `bad${i}-handover.md`), '---\nstatus: nope\ncreated: 1\n---\n');
  }
  const r = runHook(runs);
  const line = hv(r.lines).find((l) => l.includes('INVALID'));
  expect(line.startsWith('[advisor] INVALID handover file(s) (7): ')).toBe(true);
  expect(line.endsWith(', +2 more - fix or remove by hand')).toBe(true);
  expect((line.match(/\(bad-status\)/g) || []).length).toBe(5);
});

test('unreadable plans dir prints scan-failed line and exits 0', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores chmod
  const { runs, plans } = setup();
  fs.chmodSync(plans, 0o000);
  const r = runHook(runs);
  fs.chmodSync(plans, 0o755);
  expect(r.status).toBe(0);
  expect(hv(r.lines)).toContain('[advisor] handover scan failed: EACCES');
  expect(r.out).toContain('[advisor] ready');
});

test('missing plans dir prints nothing', () => {
  const runs = mk('ss-hv-runs-');
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(hv(r.lines)).toEqual([]);
  expect(r.out).toContain('[advisor] ready');
});

test('exact line texts match the contract', () => {
  const { runs, plans } = setup();
  const stale = writeHeadered(plans, 'stale-handover.md', { ageDays: 8 });
  writeHeadered(plans, 'ancient-handover.md', { ageDays: 45 });
  writeLegacy(plans, 'done-handover.md', 'FINAL OUTCOME: ok\n', 2);
  fs.writeFileSync(path.join(plans, 'bad-handover.md'), '---\nstatus: nope\ncreated: 1\n---\n');
  const r = runHook(runs);
  expect(hv(r.lines)).toEqual([
    `[advisor] STALE handover (8d old): ${stale} - resolve with bin/handover-resolve (auto-archives after 30d)`,
    '[advisor] open handovers: 1 (1 stale >7d)',
    '[advisor] archived 1 resolved handover(s)',
    '[advisor] archived 1 stale open handover(s) (unresolved >30d) to plans/_archive',
    '[advisor] INVALID handover file(s) (1): bad-handover.md (bad-status) - fix or remove by hand',
  ]);
});

test('archive failure prints the failed line and the hook still exits 0', () => {
  const { runs, plans } = setup();
  writeHeadered(plans, 'ancient-handover.md', { ageDays: 40 });
  fs.writeFileSync(path.join(plans, '_archive'), 'not a dir');
  const r = runHook(runs);
  expect(r.status).toBe(0);
  expect(hv(r.lines).some((l) => /^\[advisor\] handover archive failed \(1\): ancient-handover\.md: \w+/.test(l))).toBe(true);
  expect(fs.existsSync(path.join(plans, 'ancient-handover.md'))).toBe(true);
});
