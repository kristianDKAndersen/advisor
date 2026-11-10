import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpDir;
let prevVault;
let prevRuns;
const now = () => new Date().toISOString();
const paths = rows => rows.map(r => r.path);

beforeAll(async () => {
  prevVault = process.env.ADVISOR_VAULT;
  prevRuns = process.env.ADVISOR_RUNS_ROOT;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-lifecycle-test-'));
  process.env.ADVISOR_VAULT = tmpDir;
  process.env.ADVISOR_RUNS_ROOT = path.join(tmpDir, 'runs');
  vault = await import('../lib/vault.js');
  vault.writeNote('lessons/_init.md', { type: 'lesson' }, 'init');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (prevVault === undefined) delete process.env.ADVISOR_VAULT; else process.env.ADVISOR_VAULT = prevVault;
  if (prevRuns === undefined) delete process.env.ADVISOR_RUNS_ROOT; else process.env.ADVISOR_RUNS_ROOT = prevRuns;
});

test('searchNotes excludes status=retired by default', () => {
  vault.writeNote('lessons/lc-retired.md', { type: 'lesson', status: 'retired', created_at: now() }, 'Lifecycle token KRTA retired lesson.');
  vault.writeNote('lessons/lc-active.md', { type: 'lesson', status: 'active', created_at: now() }, 'Lifecycle token KRTA active lesson.');
  const rows = vault.searchNotes('KRTA');
  expect(paths(rows)).toContain('lessons/lc-active.md');
  expect(paths(rows)).not.toContain('lessons/lc-retired.md');
  expect(paths(vault.searchNotes('KRTA', 10, { includeInactive: true }))).toContain('lessons/lc-retired.md');
});

test('searchNotes excludes status=stale by default and includes it (halved) with includeInactive', () => {
  vault.writeNote('synthesis/lc-stale-a.md', { type: 'synthesis', created_at: now() }, 'Lifecycle token LSTB fresh.');
  vault.writeNote('synthesis/lc-stale-b.md', { type: 'synthesis', created_at: now(), status: 'stale' }, 'Lifecycle token LSTB fresh.');
  expect(paths(vault.searchNotes('LSTB'))).toEqual(['synthesis/lc-stale-a.md']);
  const all = vault.searchNotes('LSTB', 10, { includeInactive: true });
  const a = all.find(r => r.path === 'synthesis/lc-stale-a.md');
  const b = all.find(r => r.path === 'synthesis/lc-stale-b.md');
  expect(b).toBeDefined();
  expect(b.score).toBeLessThan(a.score);
  expect(b.status).toBe('stale');
});

test('searchNotes keeps stale lesson visible by default', () => {
  vault.writeNote('lessons/lc-stale-lesson.md', { type: 'lesson', status: 'stale', created_at: now() }, 'Lifecycle token MSTL stale lesson.');
  expect(paths(vault.searchNotes('MSTL'))).toContain('lessons/lc-stale-lesson.md');
});

test('searchNotes types option restricts to lesson', () => {
  vault.writeNote('lessons/lc-types.md', { type: 'lesson', created_at: now(), task_type: 'tt-types' }, 'Lifecycle token NTYP shared.');
  vault.writeNote('synthesis/lc-types.md', { type: 'synthesis', created_at: now() }, 'Lifecycle token NTYP shared.');
  expect(paths(vault.searchNotes('NTYP')).sort()).toEqual(['lessons/lc-types.md', 'synthesis/lc-types.md']);
  const rows = vault.searchNotes('NTYP', 10, { types: ['lesson'] });
  expect(paths(rows)).toEqual(['lessons/lc-types.md']);
  expect(rows[0].routing).toContain('tt-types');
});

test('setStatus refuses non-lifecycle status on a lesson', () => {
  vault.writeNote('lessons/lc-guard.md', { type: 'lesson', status: 'proposed' }, 'Guard body.');
  expect(() => vault.setStatus('lessons/lc-guard.md', 'stale')).toThrow(/lifecycle/);
  expect(() => vault.setStatus('lessons/lc-guard.md', 'bogus')).toThrow(/lifecycle/);
  expect(vault.readNote('lessons/lc-guard.md').fm.status).toBe('proposed');
  vault.writeNote('synthesis/lc-guard.md', { type: 'synthesis' }, 'Guard body.');
  vault.setStatus('synthesis/lc-guard.md', 'stale');
  expect(vault.readNote('synthesis/lc-guard.md').fm.status).toBe('stale');
});

test('setStatus accepts lifecycle status on a lesson', () => {
  vault.writeNote('lessons/lc-accept.md', { type: 'lesson', status: 'proposed', created_at: now() }, 'Accept body token VACC.');
  for (const s of vault.LESSON_STATUSES) {
    vault.setStatus('lessons/lc-accept.md', s);
    expect(vault.readNote('lessons/lc-accept.md').fm.status).toBe(s);
  }
  vault.setStatus('lessons/lc-accept.md', '');
  const d = new Database(path.join(tmpDir, '.cache', 'vault.db'));
  expect(d.prepare("SELECT status FROM notes WHERE path = 'lessons/lc-accept.md'").get().status).toBeFalsy();
  d.close();
  expect(paths(vault.searchNotes('VACC'))).toContain('lessons/lc-accept.md');
});

test('scanStale never mutates a lesson and reports flag-lesson', () => {
  const scanDir = path.join(os.homedir(), `.advisor-vault-lifecycle-scan-${process.pid}`);
  fs.mkdirSync(scanDir, { recursive: true });
  try {
    const refFile = path.join(scanDir, 'ref.txt');
    fs.writeFileSync(refFile, 'x');
    vault.writeNote('lessons/lc-scan.md', { type: 'lesson', status: 'active', created_at: new Date(Date.now() - 1000).toISOString() }, `Mentions ${refFile} here.`);
    fs.unlinkSync(refFile);
    const res = vault.scanStale();
    expect(res.report.find(r => r.path === 'lessons/lc-scan.md').action).toBe('flag-lesson');
    expect(vault.readNote('lessons/lc-scan.md').fm.status).toBe('active');
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test('moveNote renames file and reindexes the new path', () => {
  vault.writeNote('lessons/lc-move-src.md', { type: 'lesson', status: 'active', created_at: now() }, 'Lifecycle token PMOV links to [[lc-move-target]].');
  const res = vault.moveNote('lessons/lc-move-src.md', 'lessons/archive/lc-move-dst.md');
  expect(res).toEqual({ from: 'lessons/lc-move-src.md', to: 'lessons/archive/lc-move-dst.md' });
  expect(fs.existsSync(path.join(tmpDir, 'lessons/lc-move-src.md'))).toBe(false);
  expect(fs.existsSync(path.join(tmpDir, 'lessons/archive/lc-move-dst.md'))).toBe(true);
  expect(paths(vault.searchNotes('PMOV'))).toEqual(['lessons/archive/lc-move-dst.md']);
  const d = new Database(path.join(tmpDir, '.cache', 'vault.db'));
  expect(d.prepare("SELECT COUNT(*) AS c FROM notes WHERE path = 'lessons/lc-move-src.md'").get().c).toBe(0);
  const links = d.prepare("SELECT source, target FROM links WHERE source IN ('lessons/lc-move-src.md','lessons/archive/lc-move-dst.md')").all();
  d.close();
  expect(links).toEqual([{ source: 'lessons/archive/lc-move-dst.md', target: 'lc-move-target' }]);
});

test('moveNote refuses an existing target (case-insensitive)', () => {
  vault.writeNote('lessons/lc-mv-a.md', { type: 'lesson' }, 'Move A body.');
  vault.writeNote('lessons/LC-MV-Target.md', { type: 'lesson' }, 'Existing target body.');
  expect(() => vault.moveNote('lessons/lc-mv-a.md', 'lessons/lc-mv-target.md')).toThrow(/exists/);
  expect(() => vault.moveNote('lessons/lc-mv-a.md', 'lessons/LC-MV-Target.md')).toThrow(/exists/);
  expect(fs.existsSync(path.join(tmpDir, 'lessons/lc-mv-a.md'))).toBe(true);
  expect(vault.readNote('lessons/LC-MV-Target.md').body).toContain('Existing target body.');
});

test('moveNote refuses paths escaping the vault', () => {
  vault.writeNote('lessons/lc-escape.md', { type: 'lesson' }, 'Escape body.');
  expect(() => vault.moveNote('lessons/lc-escape.md', '../lc-escaped.md')).toThrow(/escapes the vault/);
  expect(() => vault.moveNote('../outside.md', 'lessons/lc-in.md')).toThrow(/escapes the vault/);
  expect(fs.existsSync(path.join(tmpDir, 'lessons/lc-escape.md'))).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(tmpDir), 'lc-escaped.md'))).toBe(false);
});

test('rebuildIndex keeps retired lesson hidden from default search', () => {
  vault.writeNote('lessons/lc-rb-retired.md', { type: 'lesson', status: 'retired', created_at: now() }, 'Lifecycle token QRBD retired.');
  vault.writeNote('lessons/lc-rb-active.md', { type: 'lesson', status: 'active', created_at: now() }, 'Lifecycle token QRBD active.');
  vault.rebuildIndex();
  const rows = vault.searchNotes('QRBD');
  expect(paths(rows)).toEqual(['lessons/lc-rb-active.md']);
  expect(paths(vault.searchNotes('QRBD', 10, { includeInactive: true }))).toContain('lessons/lc-rb-retired.md');
});

const baseRecord = (over = {}) => ({
  sid: '1794256324-abcdef', agent: 'coder', synthesis_seq: 1, task_type: 'tt-write',
  failure_mode: 'fm', evaluator_dim: 'verdict:blocked', root_cause: 'RC text', heuristic: 'H text', ...over
});

test('writeLesson defaults status to proposed', () => {
  vault.writeLesson(baseRecord({ synthesis_seq: 11 }));
  const rel = 'lessons/1794256324-abcdef-coder-11.md';
  expect(vault.readNote(rel).fm.status).toBe('proposed');
  const row = vault.searchNotes('RC text H text', 10, { types: ['lesson'] }).find(r => r.path === rel);
  expect(row.status).toBe('proposed');
});

test('writeLesson accepts body override and capture_key', () => {
  vault.writeLesson(baseRecord({
    synthesis_seq: 12, status: 'active', source: 'capture', capture_key: 'ck-123', body: 'Custom body token ZBOD.'
  }));
  const { fm, body } = vault.readNote('lessons/1794256324-abcdef-coder-12.md');
  expect(fm.status).toBe('active');
  expect(fm.source).toBe('capture');
  expect(fm.capture_key).toBe('ck-123');
  expect(body).toContain('Custom body token ZBOD.');
  expect(body).not.toContain('## Root cause');
});

const lessonAbs = rel => path.join(tmpDir, rel);
const auditLines = () => {
  try { return fs.readFileSync(path.join(tmpDir, '.cache', 'lessons.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; }
};

test('moveNote refuses symlinked target dir escaping the vault', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-outside-'));
  try {
    fs.symlinkSync(outside, lessonAbs('lessons/esc-archive'));
    vault.writeNote('lessons/esc-src.md', { type: 'lesson', status: 'active', created_at: now() }, 'Escape token ZESC.');
    expect(() => vault.moveNote('lessons/esc-src.md', 'lessons/esc-archive/esc-src.md')).toThrow();
    expect(() => vault.moveNote('lessons/esc-src.md', 'lessons/esc-archive/nested/esc-src.md')).toThrow();
    expect(fs.existsSync(lessonAbs('lessons/esc-src.md'))).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('moveNote never replaces an existing target under concurrent movers', async () => {
  // Window between the existence check and the move: another mover lands the target.
  vault.writeNote('lessons/race-a.md', { type: 'lesson', created_at: now() }, 'Loser A body.');
  fs.mkdirSync(lessonAbs('lessons/race-archive'), { recursive: true });
  fs.writeFileSync(lessonAbs('lessons/race-archive/keep.md'), 'keep');
  const target = lessonAbs('lessons/race-archive/race.md');
  const realReaddir = fs.readdirSync;
  let injected = false;
  fs.readdirSync = (...args) => {
    const res = realReaddir(...args);
    if (!injected && String(args[0]).endsWith('race-archive')) {
      injected = true;
      fs.writeFileSync(target, 'WINNER');
    }
    return res;
  };
  try {
    expect(() => vault.moveNote('lessons/race-a.md', 'lessons/race-archive/race.md')).toThrow();
  } finally {
    fs.readdirSync = realReaddir;
  }
  expect(fs.readFileSync(target, 'utf8')).toBe('WINNER');
  expect(fs.existsSync(lessonAbs('lessons/race-a.md'))).toBe(true);

  // Real processes racing for one target from different sources.
  const vaultJs = path.resolve(import.meta.dir, '../lib/vault.js');
  for (let round = 0; round < 3; round++) {
    const dest = `lessons/race-archive/round-${round}.md`;
    const srcs = ['p', 'q'].map(n => `lessons/race-${n}-${round}.md`);
    srcs.forEach((s, i) => vault.writeNote(s, { type: 'lesson', created_at: now() }, `Mover ${i} body.`));
    const startAt = Date.now() + 400;
    const procs = srcs.map(s => Bun.spawn([process.execPath, '-e',
      `const v=require(${JSON.stringify(vaultJs)});while(Date.now()<${startAt});try{v.moveNote(${JSON.stringify(s)},${JSON.stringify(dest)});process.exit(0)}catch(e){process.exit(3)}`],
      { env: { ...process.env, ADVISOR_VAULT: tmpDir, ADVISOR_RUNS_ROOT: path.join(tmpDir, 'runs') }, stdout: 'ignore', stderr: 'ignore' }));
    const codes = await Promise.all(procs.map(p => p.exited));
    expect(codes.filter(c => c === 0).length).toBe(1);
    const left = srcs.filter(s => fs.existsSync(lessonAbs(s)));
    expect(left.length).toBe(1);
    const winnerIdx = srcs.findIndex(s => !fs.existsSync(lessonAbs(s)));
    expect(fs.readFileSync(lessonAbs(dest), 'utf8')).toContain(`Mover ${winnerIdx} body.`);
  }
});

test('writeLesson refuses to overwrite an existing lesson with LESSON_EXISTS', () => {
  const rec = baseRecord({ synthesis_seq: 21 });
  const rel = 'lessons/1794256324-abcdef-coder-21.md';
  vault.writeLesson(rec);
  const before = fs.readFileSync(lessonAbs(rel), 'utf8');
  const auditBefore = auditLines();
  let err;
  try { vault.writeLesson({ ...rec, heuristic: 'CHANGED heuristic' }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  expect(err.code).toBe('LESSON_EXISTS');
  expect(fs.readFileSync(lessonAbs(rel), 'utf8')).toBe(before);
  expect(auditLines()).toBe(auditBefore);
});

test('writeLesson existing lesson keeps status and audience', () => {
  const rec = baseRecord({ synthesis_seq: 22 });
  const rel = 'lessons/1794256324-abcdef-coder-22.md';
  vault.writeLesson(rec);
  const { fm, body } = vault.readNote(rel);
  vault.writeNote(rel, { ...fm, status: 'active', audience: 'coder' }, body);
  expect(() => vault.writeLesson({ ...rec, heuristic: 'CHANGED heuristic' })).toThrow();
  const after = vault.readNote(rel);
  expect(after.fm.status).toBe('active');
  expect(after.fm.audience).toBe('coder');
  expect(after.body).toContain('H text');
  expect(after.body).not.toContain('CHANGED heuristic');
});

test('legacy search honours types and hides retired by default', () => {
  vault.writeNote('lessons/lg-active.md', { type: 'lesson', status: 'active', created_at: now() }, 'Legacy token YLGC active.');
  vault.writeNote('lessons/lg-retired.md', { type: 'lesson', status: 'retired', created_at: now() }, 'Legacy token YLGC retired.');
  vault.writeNote('synthesis/lg-syn.md', { type: 'synthesis', created_at: now() }, 'Legacy token YLGC synthesis.');
  expect(paths(vault.searchNotes('YLGC', 10, { legacy: true })).sort()).toEqual(['lessons/lg-active.md', 'synthesis/lg-syn.md']);
  expect(paths(vault.searchNotes('YLGC', 10, { legacy: true, types: ['lesson'] }))).toEqual(['lessons/lg-active.md']);
  expect(paths(vault.searchNotes('YLGC', 10, { legacy: true, includeInactive: true }))).toContain('lessons/lg-retired.md');
});
