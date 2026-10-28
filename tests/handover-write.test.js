// Tests for bin/handover-write: sid resolution, session snapshot, atomic exclusive
// create of a headered handover file under <runs>/plans. Every spawn runs with
// ADVISOR_RUNS_ROOT pointing at a temp dir; the real runs root is never touched.
import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { readHandover } from '../lib/handover.js';
import { listHandovers, newestUnresolvedHandover } from '../lib/maintenance.js';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'handover-write');
const NOW = 1_793_186_067;

const tmpDirs = [];
function mkRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-write-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function addSession(root, sid, state = { sid, phase: 'work' }, ageS = 0) {
  const dir = path.join(root, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(state, null, 2));
  const t = new Date(Date.now() - ageS * 1000);
  fs.utimesSync(dir, t, t);
}

function run(root, args = [], { env = {}, input = '' } = {}) {
  const e = { ...process.env, ADVISOR_RUNS_ROOT: root, HANDOVER_NOW: String(NOW), ...env };
  delete e.ADVISOR_SID;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [BIN, ...args], { env: e, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function plansFiles(root) {
  try { return fs.readdirSync(path.join(root, 'plans')); } catch (_) { return []; }
}

test('help exits 0 and creates nothing', () => {
  const root = mkRoot();
  const r = run(root, ['--bogus', '--help']);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/handover-write/);
  expect(fs.readdirSync(root)).toEqual([]);
  expect(run(root, ['-h']).code).toBe(0);
  expect(fs.readdirSync(root)).toEqual([]);
});

test('unknown flag exits 2 and creates nothing', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  for (const args of [['--nope'], ['--sid'], ['--slug'], ['extra']]) {
    const r = run(root, args);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/handover-write/);
  }
  expect(plansFiles(root)).toEqual([]);
});

test('writes a headered open file and prints only its absolute path', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  const r = run(root, ['--sid', 's-1']);
  expect(r.code).toBe(0);
  const lines = r.out.split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  expect(path.isAbsolute(lines[0])).toBe(true);
  expect(path.dirname(fs.realpathSync(lines[0]))).toBe(fs.realpathSync(path.join(root, 'plans')));
  expect(path.basename(lines[0])).toMatch(/^\d{8}-\d{6}-context-handover\.md$/);
  const h = readHandover(lines[0]);
  expect(h.kind).toBe('header');
  expect(h.status).toBe('open');
  expect(h.createdMs).toBe(NOW * 1000);
  expect(h.sid).toBe('s-1');
  expect(r.err).toContain('handover-write: sid=s-1 (source: flag)');
});

test('embeds the session.json snapshot and stdin notes', () => {
  const root = mkRoot();
  addSession(root, 's-2', { sid: 's-2', marker: 'snap-xyz', nested: { a: 1 } });
  const r = run(root, ['--sid', 's-2'], { input: 'remember the milk\nline two\n' });
  expect(r.code).toBe(0);
  const body = fs.readFileSync(r.out.trim(), 'utf8');
  expect(body).toContain('# Context handover s-2');
  expect(body).toContain('## Session state');
  expect(body).toContain('```json\n' + JSON.stringify({ sid: 's-2', marker: 'snap-xyz', nested: { a: 1 } }, null, 2) + '\n```');
  expect(body).toContain('## Notes\n');
  expect(body).toContain('remember the milk\nline two');
});

test('missing session.json for explicit --sid exits 2 and creates nothing', () => {
  const root = mkRoot();
  const r = run(root, ['--sid', 'ghost']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('handover-write: no session.json for ghost');
  expect(r.out).toBe('');
  expect(plansFiles(root)).toEqual([]);
});

test('ADVISOR_SID used when --sid absent; newest valid run dir otherwise; stderr names the source', () => {
  const root = mkRoot();
  addSession(root, 'older', { sid: 'older' }, 500);
  addSession(root, 'newer', { sid: 'newer' }, 10);
  fs.mkdirSync(path.join(root, 'newest-but-invalid'));

  const env = run(root, [], { env: { ADVISOR_SID: 'older' } });
  expect(env.code).toBe(0);
  expect(env.err).toContain('handover-write: sid=older (source: env)');
  expect(readHandover(env.out.trim()).sid).toBe('older');

  const newest = run(root, []);
  expect(newest.code).toBe(0);
  expect(newest.err).toContain('handover-write: sid=newer (source: newest)');
  expect(readHandover(newest.out.trim()).sid).toBe('newer');

  const flag = run(root, ['--sid', 'older'], { env: { ADVISOR_SID: 'newer' } });
  expect(flag.err).toContain('(source: flag)');
  expect(readHandover(flag.out.trim()).sid).toBe('older');
});

test('--no-session writes header with empty sid', () => {
  const root = mkRoot();
  const r = run(root, ['--no-session'], { input: 'just notes' });
  expect(r.code).toBe(0);
  const h = readHandover(r.out.trim());
  expect(h.kind).toBe('header');
  expect(h.status).toBe('open');
  expect(h.sid).toBe('');
  const body = fs.readFileSync(r.out.trim(), 'utf8');
  expect(body).not.toContain('## Session state');
  expect(body).toContain('just notes');
});

test('same-second writes get distinct names via suffix', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  const a = run(root, ['--sid', 's-1'], { input: 'first' });
  const b = run(root, ['--sid', 's-1'], { input: 'second' });
  const c = run(root, ['--sid', 's-1', '--slug', 'x'], { input: 'third' });
  const d = run(root, ['--sid', 's-1', '--slug', 'x'], { input: 'fourth' });
  expect([a.code, b.code, c.code, d.code]).toEqual([0, 0, 0, 0]);
  const names = [a, b, c, d].map((r) => path.basename(r.out.trim()));
  expect(new Set(names).size).toBe(4);
  expect(names[1]).toMatch(/^\d{8}-\d{6}-2-context-handover\.md$/);
  expect(names[2]).toMatch(/^\d{8}-\d{6}-x-context-handover\.md$/);
  expect(names[3]).toMatch(/^\d{8}-\d{6}-x-2-context-handover\.md$/);
  const notes = ['first', 'second', 'third', 'fourth'];
  [a, b, c, d].forEach((r, i) => expect(fs.readFileSync(r.out.trim(), 'utf8')).toContain(notes[i]));
});

test('slug traversal and uppercase are sanitized inside plans', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  const cases = [
    ['../x', '-x-'],
    ['a/b', '-a-b-'],
    ['/etc/passwd', '-etc-passwd-'],
    ['Foo_BAR!!', '-foo-bar-'],
  ];
  for (const [slug, frag] of cases) {
    const r = run(root, ['--sid', 's-1', '--slug', slug, '--no-session']);
    expect(r.code).toBe(0);
    const p = fs.realpathSync(r.out.trim());
    expect(path.dirname(p)).toBe(fs.realpathSync(path.join(root, 'plans')));
    expect(path.basename(p)).toContain(frag);
    expect(path.basename(p)).toMatch(/^[0-9]{8}-[0-9]{6}(-[a-z0-9]+)+-context-handover\.md$/);
  }
  const long = run(root, ['--slug', 'a'.repeat(100), '--no-session']);
  expect(path.basename(long.out.trim())).toMatch(new RegExp(`^\\d{8}-\\d{6}-a{40}-context-handover\\.md$`));
  const empty = run(root, ['--slug', '!!!', '--no-session']);
  expect(path.basename(empty.out.trim())).toMatch(/^\d{8}-\d{6}(-\d+)?-context-handover\.md$/);
  expect(fs.readdirSync(root).filter((n) => n !== 'plans' && n !== 's-1')).toEqual([]);
});

test('hostile sid is sanitized', () => {
  const root = mkRoot();
  addSession(root, '.._.._evil', { sid: 'x', marker: 'sanitized-dir' });
  const r = run(root, ['--sid', '../../evil']);
  expect(r.code).toBe(0);
  expect(readHandover(r.out.trim()).sid).toBe('.._.._evil');
  expect(fs.readFileSync(r.out.trim(), 'utf8')).toContain('sanitized-dir');
  // a sid made only of dots would escape the runs root: refused
  for (const bad of ['..', '.', '']) {
    const b = run(root, ['--sid', bad]);
    expect(b.code).toBe(2);
  }
  expect(plansFiles(root).length).toBe(1);
});

test('symlinked plans dir exits 3', () => {
  const root = mkRoot();
  const elsewhere = mkRoot();
  addSession(root, 's-1');
  fs.symlinkSync(elsewhere, path.join(root, 'plans'));
  const r = run(root, ['--sid', 's-1']);
  expect(r.code).toBe(3);
  expect(r.out).toBe('');
  expect(fs.readdirSync(elsewhere)).toEqual([]);

  const root2 = mkRoot();
  const target = mkRoot();
  addSession(root2, 's-1');
  fs.mkdirSync(path.join(root2, 'plans'));
  fs.symlinkSync(target, path.join(root2, 'plans', '_archive'));
  const r2 = run(root2, ['--sid', 's-1']);
  expect(r2.code).toBe(3);
  expect(plansFiles(root2)).toEqual(['_archive']);
  expect(fs.readdirSync(target)).toEqual([]);
});

test('empty stdin still writes', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  const r = run(root, ['--sid', 's-1'], { input: '' });
  expect(r.code).toBe(0);
  const body = fs.readFileSync(r.out.trim(), 'utf8');
  expect(body).toContain('## Session state');
  expect(body).not.toContain('## Notes');
  const ws = run(root, ['--sid', 's-1'], { input: '  \n\n' });
  expect(fs.readFileSync(ws.out.trim(), 'utf8')).not.toContain('## Notes');
});

test('result is open in listHandovers and surfaced by newestUnresolvedHandover', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  const r = run(root, ['--sid', 's-1'], { input: 'n' });
  const p = r.out.trim();
  const listed = listHandovers(root).filter((h) => h.path === p || fs.realpathSync(h.path) === fs.realpathSync(p));
  expect(listed.length).toBe(1);
  expect(listed[0].resolved).toBe(false);
  expect(fs.realpathSync(newestUnresolvedHandover(root))).toBe(fs.realpathSync(p));
});

test('no .hv-tmp left after success', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  for (let i = 0; i < 3; i++) expect(run(root, ['--sid', 's-1']).code).toBe(0);
  const names = plansFiles(root);
  expect(names.length).toBe(3);
  expect(names.filter((n) => n.startsWith('.hv-tmp.'))).toEqual([]);
  for (const n of names) expect(fs.statSync(path.join(root, 'plans', n)).size).toBeGreaterThan(0);
});

test('no linkSync used (source grep)', () => {
  expect(fs.readFileSync(BIN, 'utf8')).not.toMatch(/linkSync/);
  expect(fs.readFileSync(path.resolve(BIN, '..', '..', 'lib', 'handover.js'), 'utf8')).not.toMatch(/linkSync/);
});

test('TZ=Pacific/Auckland and TZ=UTC give the same created epoch', () => {
  const root = mkRoot();
  addSession(root, 's-1');
  const a = run(root, ['--sid', 's-1'], { env: { TZ: 'Pacific/Auckland' } });
  const b = run(root, ['--sid', 's-1'], { env: { TZ: 'UTC' } });
  expect([a.code, b.code]).toEqual([0, 0]);
  const ha = readHandover(a.out.trim());
  const hb = readHandover(b.out.trim());
  expect(ha.createdMs).toBe(NOW * 1000);
  expect(hb.createdMs).toBe(ha.createdMs);
});
