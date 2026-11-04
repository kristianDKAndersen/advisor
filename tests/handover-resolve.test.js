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

// --- D-f CLI contract: header rewrite, exit codes 0/1/2/3/4, help-first ---
// Every spawn gets ADVISOR_RUNS_ROOT pointing at a temp dir, never the real runs root.
const lib = () => import('../lib/handover.js');

function mkPlans(prefix = 'hres-d-') {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  return { runs, plans: fs.realpathSync(plans) };
}

function run(runs, args, cwd) {
  return spawnSync('bun', [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ADVISOR_RUNS_ROOT: runs } });
}

async function headered(plans, name, body, fields = {}) {
  const { renderHeader } = await lib();
  const created = Math.floor(Date.now() / 1000) - 100;
  const f = path.join(plans, name);
  fs.writeFileSync(f, renderHeader({ status: 'open', created, sid: 's1', ...fields }) + body);
  return f;
}

const noTmp = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.hv-tmp.'));

const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'hres-case-'));
fs.writeFileSync(path.join(probe, 'a'), '');
const caseInsensitiveFs = fs.existsSync(path.join(probe, 'A'));
fs.rmSync(probe, { recursive: true, force: true });

test('help prints usage exit 0 and touches nothing', () => {
  const { runs, plans } = mkPlans();
  const before = fs.readdirSync(plans);
  for (const args of [['--help'], ['-h'], ['/no/such/handover.md', '--outcome', 'x', '-h'], ['--bogus', '--help']]) {
    const r = run(runs, args, plans);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: handover-resolve <file> --outcome/);
    expect(r.stderr).toBe('');
  }
  expect(fs.readdirSync(plans)).toEqual(before);
  expect(fs.readdirSync(runs)).toEqual(['plans']);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('resolves a headered file: status, resolved epoch, outcome set, body bytes identical, no tmp left', async () => {
  const { classifyContent } = await lib();
  const { runs, plans } = mkPlans();
  const body = '# Handover\r\n\r\nbody FINAL OUTCOME: not this\n\ttabbed  \nno trailing newline';
  const f = await headered(plans, 'x-context-handover.md', body);
  fs.chmodSync(f, 0o640);
  const t0 = Math.floor(Date.now() / 1000);
  const r = run(runs, [f, '--outcome', 'shipped in session abc'], plans);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(`resolved ${f}\n`);
  const after = fs.readFileSync(f, 'utf8');
  expect(after.endsWith(`\n---\n${body}`)).toBe(true);
  const h = classifyContent(after, { mtimeMs: 0, nowMs: Date.now() });
  expect(h.kind).toBe('header');
  expect(h.status).toBe('resolved');
  expect(h.outcome).toBe('shipped in session abc');
  expect(h.sid).toBe('s1');
  expect(h.resolvedMs / 1000).toBeGreaterThanOrEqual(t0);
  expect(h.resolvedMs / 1000).toBeLessThanOrEqual(t0 + 30);
  expect(fs.statSync(f).mode & 0o777).toBe(0o640);
  expect(noTmp(plans)).toEqual([]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('outcome with newline is one line and cannot inject keys', async () => {
  const { classifyContent } = await lib();
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'inj-handover.md', 'body\n');
  const r = run(runs, [f, '--outcome', 'done\n---\nstatus: open\nsid: evil\r\ncreated: 1'], plans);
  expect(r.status).toBe(0);
  const after = fs.readFileSync(f, 'utf8');
  expect(after.split('\n').filter((l) => l === '---').length).toBe(2);
  const h = classifyContent(after, { mtimeMs: 0, nowMs: Date.now() });
  expect(h.status).toBe('resolved');
  expect(h.sid).toBe('s1');
  expect(h.outcome).toBe('done --- status: open sid: evil created: 1');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('outcome over 200 chars is truncated', async () => {
  const { classifyContent } = await lib();
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'long-handover.md', 'body\n');
  const r = run(runs, [f, '--outcome', 'x'.repeat(300)], plans);
  expect(r.status).toBe(0);
  const h = classifyContent(fs.readFileSync(f, 'utf8'), { mtimeMs: 0, nowMs: Date.now() });
  expect(h.outcome).toBe('x'.repeat(200));
  fs.rmSync(runs, { recursive: true, force: true });
});

test('empty or whitespace outcome exits 2', async () => {
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'empty-out-handover.md', 'body\n');
  const orig = fs.readFileSync(f, 'utf8');
  for (const args of [[f, '--outcome', ''], [f, '--outcome', '  \n '], [f, '--outcome'], [f]]) {
    const r = run(runs, args, plans);
    expect(r.status).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  }
  const unknown = run(runs, [f, '--outcome', 'x', '--bogus'], plans);
  expect(unknown.status).toBe(2);
  expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('already-resolved headered file exits 4 unchanged', async () => {
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'done-handover.md', 'body\n', { status: 'resolved', resolved: Math.floor(Date.now() / 1000) - 50, outcome: 'first' });
  const orig = fs.readFileSync(f, 'utf8');
  const r = run(runs, [f, '--outcome', 'again'], plans);
  expect(r.status).toBe(4);
  expect(r.stderr).toMatch(/already resolved/);
  expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('second resolve exits 4 and keeps first outcome', async () => {
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'twice-handover.md', 'body\n');
  expect(run(runs, [f, '--outcome', 'first outcome'], plans).status).toBe(0);
  const afterFirst = fs.readFileSync(f, 'utf8');
  const r = run(runs, [f, '--outcome', 'second outcome'], plans);
  expect(r.status).toBe(4);
  expect(fs.readFileSync(f, 'utf8')).toBe(afterFirst);
  expect(afterFirst).toContain('outcome: first outcome');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('legacy open file still gets appended FINAL OUTCOME line', () => {
  const { runs, plans } = mkPlans();
  const f = path.join(plans, 'legacy-handover.md');
  fs.writeFileSync(f, '# Context handover\n\nlegacy body, mentions FINAL OUTCOME mid-line only\n');
  const r = run(runs, [f, '--outcome', 'legacy done'], plans);
  expect(r.status).toBe(0);
  const after = fs.readFileSync(f, 'utf8');
  expect(after).toBe('# Context handover\n\nlegacy body, mentions FINAL OUTCOME mid-line only\n\nFINAL OUTCOME: legacy done\n');
  expect(after.startsWith('---')).toBe(false);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('invalid header file exits 2 unmodified', () => {
  const { runs, plans } = mkPlans();
  const f = path.join(plans, 'bad-handover.md');
  const orig = '---\nstatus: bogus\ncreated: 1\n---\nbody\n';
  fs.writeFileSync(f, orig);
  const r = run(runs, [f, '--outcome', 'x'], plans);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/bad-status/);
  expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('symlink arg exits 3', async () => {
  const { runs, plans } = mkPlans();
  const real = await headered(plans, 'real-handover.md', 'body\n');
  const orig = fs.readFileSync(real, 'utf8');
  const link = path.join(plans, 'link-handover.md');
  fs.symlinkSync(real, link);
  const r = run(runs, [link, '--outcome', 'x'], plans);
  expect(r.status).toBe(3);
  expect(fs.readFileSync(real, 'utf8')).toBe(orig);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

  const arch = path.join(plans, '_archive');
  fs.mkdirSync(arch);
  const archived = await headered(arch, 'old-handover.md', 'body\n');
  const link2 = path.join(plans, 'link2-handover.md');
  fs.symlinkSync(archived, link2);
  const r2 = run(runs, [link2, '--outcome', 'x'], plans);
  expect(r2.status).toBe(3);
  expect(classifyOpen(fs.readFileSync(archived, 'utf8'))).toBe(true);
  fs.rmSync(runs, { recursive: true, force: true });
});
const classifyOpen = (c) => /^status: open$/m.test(c);

test('file under _archive exits 2', async () => {
  const { runs, plans } = mkPlans();
  const arch = path.join(plans, '_archive');
  fs.mkdirSync(arch);
  const f = await headered(arch, 'old-handover.md', 'body\n');
  const orig = fs.readFileSync(f, 'utf8');
  const r = run(runs, [f, '--outcome', 'x'], plans);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/already archived/);
  expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('relative and .. paths reach the same file', async () => {
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'rel-handover.md', 'body\n');
  const first = run(runs, ['./rel-handover.md', '--outcome', 'via relative'], plans);
  expect(first.status).toBe(0);
  expect(first.stdout).toBe(`resolved ${f}\n`);
  expect(run(runs, ['../plans/rel-handover.md', '--outcome', 'via dotdot'], plans).status).toBe(4);
  expect(run(runs, [f, '--outcome', 'via absolute'], plans).status).toBe(4);
  expect(fs.readFileSync(f, 'utf8')).toContain('outcome: via relative');
  fs.rmSync(runs, { recursive: true, force: true });
});

test.skipIf(!caseInsensitiveFs)('case-variant name resolves the real file (skip if case-sensitive fs)', async () => {
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'case-handover.md', 'body\n');
  const r = run(runs, [path.join(plans, 'CASE-HANDOVER.MD'), '--outcome', 'via case variant'], plans);
  expect(r.status).toBe(0);
  expect(fs.readFileSync(f, 'utf8')).toContain('status: resolved');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('missing file exits 2 and creates nothing', () => {
  const { runs, plans } = mkPlans();
  const r = run(runs, [path.join(plans, 'nope-handover.md'), '--outcome', 'x'], plans);
  expect(r.status).toBe(2);
  expect(fs.readdirSync(plans)).toEqual([]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('target removed before rename is not recreated', async () => {
  const { resolveHandover } = await lib();
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'race-handover.md', 'body\n');
  const res = resolveHandover(f, 'late', { beforeRename: () => fs.rmSync(f) });
  expect([2, 4]).toContain(res.code);
  expect(fs.existsSync(f)).toBe(false);
  expect(fs.readdirSync(plans)).toEqual([]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('symlinked plans dir exits 3 and changes nothing', async () => {
  const { runs, plans } = mkPlans();
  const real = await headered(plans, 'real-handover.md', 'body\n');
  const orig = fs.readFileSync(real, 'utf8');
  const linkDir = path.join(runs, 'plans-link');
  fs.symlinkSync(plans, linkDir);
  const r = run(runs, [path.join(linkDir, 'real-handover.md'), '--outcome', 'x'], runs);
  expect(r.status).toBe(3);
  expect(r.stderr).toMatch(/refusing symlinked directory/);
  expect(fs.readFileSync(real, 'utf8')).toBe(orig);
  expect(noTmp(plans)).toEqual([]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test.skipIf(process.getuid && process.getuid() === 0)('unreadable handover exits 2', async () => {
  const { runs, plans } = mkPlans();
  const f = await headered(plans, 'locked-handover.md', 'body\n');
  fs.chmodSync(f, 0o000);
  const r = run(runs, [f, '--outcome', 'x'], plans);
  fs.chmodSync(f, 0o600);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/unreadable/);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('resolve works on a file whose closing fence has a trailing space', async () => {
  const { runs, plans } = mkPlans();
  const f = path.join(plans, 'ws-handover.md');
  const created = Math.floor(Date.now() / 1000) - 100;
  fs.writeFileSync(f, `--- \nstatus: open\ncreated: ${created}\nsid: s1\n--- \nbody\n`);
  const r = run(runs, [f, '--outcome', 'done'], plans);
  expect(r.status).toBe(0);
  const out = fs.readFileSync(f, 'utf8');
  expect(out.startsWith('--- \n')).toBe(true);
  expect(out).toMatch(/^status: resolved$/m);
  expect(out).toMatch(/^outcome: done$/m);
  expect(out).toMatch(/\n--- \nbody\n$/);
  fs.rmSync(runs, { recursive: true, force: true });
});
