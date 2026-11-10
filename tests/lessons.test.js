import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault, lessons, tmpDir, prevVault, prevRuns, doctrine;
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const abs = rel => path.join(tmpDir, rel);
const bytes = rel => fs.readFileSync(abs(rel));
const countFiles = dir => fs.readdirSync(abs(dir), { recursive: true }).filter(f => f.endsWith('.md')).length;
const HEUR = '## Heuristic\nAlways check the branch first.\n';

function lesson(name, fm = {}, body = HEUR) {
  const rel = `lessons/${name}.md`;
  vault.writeNote(rel, { type: 'lesson', created_at: iso(Date.now()), ...fm }, body);
  return rel;
}

beforeAll(async () => {
  prevVault = process.env.ADVISOR_VAULT;
  prevRuns = process.env.ADVISOR_RUNS_ROOT;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-test-'));
  process.env.ADVISOR_VAULT = tmpDir;
  process.env.ADVISOR_RUNS_ROOT = path.join(tmpDir, 'runs');
  vault = await import('../lib/vault.js');
  lessons = await import('../lib/lessons.js');
  doctrine = path.join(tmpDir, 'doctrine.md');
  fs.writeFileSync(doctrine, 'Rule one: verify the branch.\nRule two: run the suite.\n');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (prevVault === undefined) delete process.env.ADVISOR_VAULT; else process.env.ADVISOR_VAULT = prevVault;
  if (prevRuns === undefined) delete process.env.ADVISOR_RUNS_ROOT; else process.env.ADVISOR_RUNS_ROOT = prevRuns;
});

test('approve refuses empty Heuristic', () => {
  const rel = lesson('ap-empty', { status: 'proposed', audience: 'both' }, '## Heuristic\n\n## Evidence\nx\n');
  expect(() => lessons.approveLesson(rel)).toThrow(/Heuristic/);
  expect(vault.readNote(rel).fm.status).toBe('proposed');
});

test('approve proposed->active', () => {
  const rel = lesson('ap-ok', { status: 'proposed', audience: 'worker' });
  const r = lessons.approveLesson('ap-ok.md');
  expect(r.dryRun).toBe(false);
  expect(r.changed.length).toBe(1);
  expect(vault.readNote(rel).fm.status).toBe('active');
});

test('approve legacy archived -> active', () => {
  const a = lesson('ap-arch', { status: 'archived', audience: 'both' });
  const b = lesson('ap-null', { audience: 'both' });
  const c = lesson('ap-blank', { status: '', audience: 'both' });
  for (const rel of [a, b, c]) {
    lessons.approveLesson(rel);
    expect(vault.readNote(rel).fm.status).toBe('active');
  }
});

test('approve refuses retired', () => {
  const rel = lesson('ap-ret', { status: 'retired', audience: 'both' });
  expect(() => lessons.approveLesson(rel)).toThrow(/retired/);
  const p = lesson('ap-prom', { status: 'promoted', audience: 'both' });
  expect(() => lessons.approveLesson(p)).toThrow(/promoted/);
  expect(vault.readNote(rel).fm.status).toBe('retired');
});

test('approve requires audience', () => {
  const rel = lesson('ap-aud', { status: 'proposed' });
  expect(() => lessons.approveLesson(rel)).toThrow(/audience/);
  expect(vault.readNote(rel).fm.status).toBe('proposed');
  expect(() => lessons.approveLesson(rel, { audience: 'bogus' })).toThrow(/audience/);
  lessons.approveLesson(rel, { audience: 'advisor' });
  const fm = vault.readNote(rel).fm;
  expect(fm.status).toBe('active');
  expect(fm.audience).toBe('advisor');
});

test('setAudience rejects invalid value', () => {
  const rel = lesson('aud-set', { status: 'active' });
  expect(() => lessons.setAudience(rel, { audience: 'everyone' })).toThrow(/audience/);
  expect(() => lessons.setAudience(rel, {})).toThrow(/audience/);
  lessons.setAudience(rel, { audience: 'worker' });
  expect(vault.readNote(rel).fm.audience).toBe('worker');
});

test('listLessons filters by status and audience and returns audience', () => {
  lesson('ls-a', { status: 'active', audience: 'advisor' });
  lesson('ls-b', { status: 'active' });
  const act = lessons.listLessons({ status: 'active' });
  expect(act.find(l => l.path === 'lessons/ls-a.md').audience).toBe('advisor');
  expect(act.find(l => l.path === 'lessons/ls-b.md').audience).toBe('both');
  const adv = lessons.listLessons({ audience: 'advisor' });
  expect(adv.every(l => l.audience === 'advisor')).toBe(true);
  expect(adv.map(l => l.path)).toContain('lessons/ls-a.md');
  expect(adv.map(l => l.path)).not.toContain('lessons/ls-b.md');
});

test('promote refuses anchor absent from doctrine', () => {
  const rel = lesson('pr-no', { status: 'active', audience: 'both' });
  expect(() => lessons.promoteLesson(rel, { to: 'Rule nine: nothing', doctrinePath: doctrine })).toThrow(/doctrine/);
  expect(vault.readNote(rel).fm.status).toBe('active');
});

test('promote sets promoted_to', () => {
  const rel = lesson('pr-ok', { status: 'active', audience: 'both' });
  lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine });
  const fm = vault.readNote(rel).fm;
  expect(fm.status).toBe('promoted');
  expect(fm.promoted_to).toBe('Rule two: run the suite.');
});

test('retire sets status and moves to lessons/archive', () => {
  const rel = lesson('rt-ok', { status: 'active', audience: 'both' });
  const r = lessons.retireLesson(rel, { reason: 'superseded\nby doctrine' });
  expect(r.changed.length).toBe(1);
  expect(fs.existsSync(abs(rel))).toBe(false);
  const moved = vault.readNote('lessons/archive/rt-ok.md');
  expect(moved.fm.status).toBe('retired');
  expect(moved.fm.retired_reason).toBe('superseded by doctrine');
  expect(Number.isFinite(Date.parse(moved.fm.retired_at))).toBe(true);
});

test('retire is idempotent after interrupted move', () => {
  const rel = lesson('rt-int', { status: 'active', audience: 'both' });
  const note = vault.readNote(rel);
  vault.writeNote(rel, { ...note.fm, status: 'retired', retired_at: '2026-01-01T00:00:00.000Z', retired_reason: 'old' }, note.body);
  lessons.retireLesson(rel, { reason: 'new' });
  const moved = vault.readNote('lessons/archive/rt-int.md');
  expect(moved.fm.status).toBe('retired');
  expect(moved.fm.retired_at).toBe('2026-01-01T00:00:00.000Z');
  expect(fs.existsSync(abs(rel))).toBe(false);
  expect(lessons.retireLesson('rt-int.md').changed).toEqual([]);
});

test('retire never deletes (file count unchanged)', () => {
  lesson('rt-cnt', { status: 'active', audience: 'both' });
  const before = countFiles('lessons');
  lessons.retireLesson('rt-cnt.md');
  expect(countFiles('lessons')).toBe(before);
});

test('concurrent retire of same lesson: one move, one no-op', async () => {
  const rel = lesson('rt-race', { status: 'active', audience: 'both' });
  const lib = path.resolve(import.meta.dir, '../lib/lessons.js');
  const code = `const r = require(${JSON.stringify(lib)}).retireLesson('rt-race.md'); console.log(JSON.stringify(r.changed.length));`;
  const run = () => Bun.spawn([process.execPath, '-e', code], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const procs = [run(), run()];
  const outs = await Promise.all(procs.map(async p => ({ out: (await new Response(p.stdout).text()).trim(), err: await new Response(p.stderr).text(), code: await p.exited })));
  for (const o of outs) expect([o.code, o.err]).toEqual([0, '']);
  expect(outs.map(o => o.out).sort()).toEqual(['0', '1']);
  expect(fs.existsSync(abs(rel))).toBe(false);
  expect(vault.readNote('lessons/archive/rt-race.md').fm.status).toBe('retired');
});

test('keep sets reviewed_at', () => {
  const rel = lesson('kp', { status: 'active', audience: 'both' });
  lessons.keepLesson(rel);
  expect(Number.isFinite(Date.parse(vault.readNote(rel).fm.reviewed_at))).toBe(true);
});

test('reviewQueue lists zero-recall-90d scan-stale proposed anchor-missing legacy-archived', () => {
  const old = iso(Date.now() - 120 * DAY);
  lesson('rq-zero', { status: 'active', audience: 'both', created_at: old });
  lesson('rq-kept', { status: 'active', audience: 'both', created_at: old, reviewed_at: iso(Date.now() - 10 * DAY) });
  lesson('rq-fresh', { status: 'active', audience: 'both' });
  lesson('rq-stale', { status: 'active', audience: 'both', created_at: old }, `${HEUR}\nSee /Users/nobody/definitely-missing-file.txt\n`);
  lesson('rq-prop', { status: 'proposed', audience: 'both' });
  lesson('rq-anchor', { status: 'promoted', audience: 'both', promoted_to: 'gone anchor text' });
  lesson('rq-anchor-ok', { status: 'promoted', audience: 'both', promoted_to: 'Rule one: verify the branch.' });
  lesson('rq-legacy', { status: 'archived', audience: 'both' });
  const q = lessons.reviewQueue({ doctrinePath: doctrine });
  const has = (name, reason) => q.some(e => e.path === `lessons/${name}.md` && e.reason === reason);
  expect(has('rq-zero', 'zero-recall-90d')).toBe(true);
  expect(has('rq-kept', 'zero-recall-90d')).toBe(false);
  expect(has('rq-fresh', 'zero-recall-90d')).toBe(false);
  expect(has('rq-stale', 'scan-stale')).toBe(true);
  expect(has('rq-prop', 'proposed')).toBe(true);
  expect(has('rq-anchor', 'anchor-missing')).toBe(true);
  expect(has('rq-anchor-ok', 'anchor-missing')).toBe(false);
  expect(has('rq-legacy', 'legacy-archived')).toBe(true);
});

test('reviewQueue honours recalls inside the 90d window', () => {
  const old = iso(Date.now() - 120 * DAY);
  lesson('rq-recalled', { status: 'active', audience: 'both', created_at: old });
  const { appendRecall } = require('../lib/recall-telemetry.js');
  appendRecall({ sid: 's1', agent: 'coder', queryHash: 'h', lessons: [{ path: 'lessons/rq-recalled.md' }] });
  const q = lessons.reviewQueue({ doctrinePath: doctrine });
  expect(q.some(e => e.path === 'lessons/rq-recalled.md' && e.reason === 'zero-recall-90d')).toBe(false);
});

test('reviewQueue lists audience-missing', () => {
  lesson('rq-noaud', { status: 'active' });
  lesson('rq-aud', { status: 'active', audience: 'worker' });
  const q = lessons.reviewQueue({ doctrinePath: doctrine });
  expect(q.some(e => e.path === 'lessons/rq-noaud.md' && e.reason === 'audience-missing')).toBe(true);
  expect(q.some(e => e.path === 'lessons/rq-aud.md' && e.reason === 'audience-missing')).toBe(false);
});

test('resolveLessonRef rejects .. and absolute outside vault and escaping symlink', () => {
  const rel = lesson('rs-ok', { status: 'active', audience: 'both' });
  expect(lessons.resolveLessonRef('rs-ok.md').rel).toBe(rel);
  expect(lessons.resolveLessonRef(rel).rel).toBe(rel);
  expect(lessons.resolveLessonRef(abs(rel)).rel).toBe(rel);
  expect(() => lessons.resolveLessonRef('../notes/x.md')).toThrow();
  expect(() => lessons.resolveLessonRef('lessons/../doctrine.md')).toThrow();
  expect(() => lessons.resolveLessonRef(doctrine)).toThrow();
  expect(() => lessons.resolveLessonRef('')).toThrow();
  const outside = path.join(os.tmpdir(), `lessons-outside-${process.pid}.md`);
  fs.writeFileSync(outside, '---\ntype: lesson\n---\n\nx');
  fs.symlinkSync(outside, abs('lessons/rs-link.md'));
  try {
    expect(() => lessons.resolveLessonRef('rs-link.md')).toThrow();
    expect(() => lessons.approveLesson('rs-link.md', { audience: 'both' })).toThrow();
  } finally {
    fs.unlinkSync(abs('lessons/rs-link.md'));
    fs.rmSync(outside, { force: true });
  }
});

const dryCases = {
  approveLesson: (rel) => lessons.approveLesson(rel, { dryRun: true, audience: 'both' }),
  promoteLesson: (rel) => lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine, dryRun: true }),
  retireLesson: (rel) => lessons.retireLesson(rel, { reason: 'x', dryRun: true }),
  keepLesson: (rel) => lessons.keepLesson(rel, { dryRun: true }),
  setAudience: (rel) => lessons.setAudience(rel, { audience: 'worker', dryRun: true }),
};
for (const [name, call] of Object.entries(dryCases)) {
  test(`dry-run ${name} leaves files byte-identical`, () => {
    const rel = lesson(`dry-${name}`, { status: name === 'promoteLesson' ? 'active' : 'proposed' });
    const before = bytes(rel);
    const count = countFiles('lessons');
    const r = call(rel);
    expect(r.dryRun).toBe(true);
    expect(r.changed.length).toBeGreaterThan(0);
    expect(bytes(rel).equals(before)).toBe(true);
    expect(countFiles('lessons')).toBe(count);
  });
}

test('promote refuses retired', () => {
  const rel = lesson('pr-retired', { status: 'retired', audience: 'both' });
  expect(() => lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine })).toThrow(/retired/);
  expect(vault.readNote(rel).fm.status).toBe('retired');
});

test('promote refuses proposed', () => {
  const rel = lesson('pr-proposed', { status: 'proposed', audience: 'both' });
  expect(() => lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine })).toThrow(/proposed/);
  expect(vault.readNote(rel).fm.status).toBe('proposed');
});

test('promote refuses empty heuristic', () => {
  const rel = lesson('pr-emptyheur', { status: 'active', audience: 'both' }, '## Heuristic\n\n## Evidence\nx\n');
  expect(() => lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine })).toThrow(/Heuristic/);
  expect(vault.readNote(rel).fm.status).toBe('active');
});

test('promote accepts legacy status-less lesson with heuristic', () => {
  const rel = lesson('pr-legacy', { audience: 'both' });
  lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine });
  expect(vault.readNote(rel).fm.status).toBe('promoted');
  const arch = lesson('pr-legacy-arch', { status: 'archived', audience: 'both' });
  lessons.promoteLesson(arch, { to: 'Rule two: run the suite.', doctrinePath: doctrine });
  expect(vault.readNote(arch).fm.status).toBe('promoted');
});

test('reviewQueue lists status-less lesson as legacy-unstatused and audience-missing', () => {
  const old = iso(Date.now() - 120 * DAY);
  lesson('rq-nostatus', { created_at: old });
  lesson('rq-blankstatus', { status: '', created_at: old });
  const q = lessons.reviewQueue({ doctrinePath: doctrine });
  for (const name of ['rq-nostatus', 'rq-blankstatus']) {
    const has = reason => q.some(e => e.path === `lessons/${name}.md` && e.reason === reason);
    expect(has('legacy-unstatused')).toBe(true);
    expect(has('audience-missing')).toBe(true);
    expect(has('zero-recall-90d')).toBe(true);
  }
});

test('mutators refuse non-lesson note', () => {
  const rel = 'lessons/not-a-lesson.md';
  vault.writeNote(rel, { type: 'synthesis', status: 'proposed', audience: 'both' }, HEUR);
  const before = bytes(rel);
  const calls = [
    () => lessons.approveLesson(rel, { audience: 'both' }),
    () => lessons.setAudience(rel, { audience: 'worker' }),
    () => lessons.promoteLesson(rel, { to: 'Rule two: run the suite.', doctrinePath: doctrine }),
    () => lessons.keepLesson(rel),
    () => lessons.retireLesson(rel, { reason: 'x' }),
  ];
  for (const call of calls) expect(call).toThrow(/not a lesson/);
  expect(bytes(rel).equals(before)).toBe(true);
});

test('retire of missing subdir ref is not found even if archive has same basename', () => {
  vault.writeNote('lessons/archive/rt-dup.md', { type: 'lesson', status: 'retired', created_at: iso(Date.now()) }, HEUR);
  expect(() => lessons.retireLesson('lessons/sub/rt-dup.md')).toThrow(/not found/);
  expect(() => lessons.retireLesson('lessons/archive/nope/rt-dup.md')).toThrow(/not found/);
  expect(lessons.retireLesson('rt-dup.md').changed).toEqual([]);
  expect(lessons.retireLesson('lessons/rt-dup.md').changed).toEqual([]);
});

test('ref that is a symlink is refused', () => {
  const rel = lesson('sl-target', { status: 'active', audience: 'both' });
  const alias = abs('lessons/sl-alias.md');
  fs.symlinkSync(abs(rel), alias);
  try {
    expect(() => lessons.resolveLessonRef('sl-alias.md')).toThrow(/symlink/);
    expect(() => lessons.retireLesson('sl-alias.md')).toThrow(/symlink/);
    expect(fs.existsSync(abs(rel))).toBe(true);
  } finally {
    fs.unlinkSync(alias);
  }
});
