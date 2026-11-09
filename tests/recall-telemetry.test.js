import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MOD = path.resolve(import.meta.dir, '../lib/recall-telemetry.js');
let tmp, vault, runs, T;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tel-'));
  vault = path.join(tmp, 'vault');
  runs = path.join(tmp, 'runs');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  process.env.ADVISOR_VAULT = vault;
  process.env.ADVISOR_RUNS_ROOT = runs;
  T = require(MOD);
});
afterEach(() => {
  delete process.env.ADVISOR_VAULT;
  delete process.env.ADVISOR_RUNS_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const logPath = () => path.join(vault, '.cache', 'recall.jsonl');
const lines = () => fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean);
const lesson = (p, rank = 1) => ({ path: p, rank, routing_hits: 2, score: 0.5 });

function writeOutbox(sid, msgs) {
  const dir = path.join(runs, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'outbox.jsonl'), msgs.map(m => JSON.stringify(m)).join('\n') + '\n');
}

test('appendRecall writes one line with sid agent lessons ts', () => {
  T.appendRecall({ sid: 's1', agent: 'coder', queryHash: T.hashQuery('x'), lessons: [lesson('lessons/a.md')], notes: ['n/b.md'] });
  const ls = lines();
  expect(ls.length).toBe(1);
  const r = JSON.parse(ls[0]);
  expect(r.v).toBe(1);
  expect(r.sid).toBe('s1');
  expect(r.agent).toBe('coder');
  expect(r.lessons[0].path).toBe('lessons/a.md');
  expect(r.notes).toEqual(['n/b.md']);
  expect(typeof r.ts).toBe('number');
  expect(r.query_hash).toMatch(/^sha256:[0-9a-f]{16}$/);
});

test('concurrent appends from 3 child processes yield 3 parseable lines', async () => {
  const code = `require(${JSON.stringify(MOD)}).appendRecall({sid:process.argv[1],agent:'coder',queryHash:'h',lessons:[{path:'lessons/a.md',rank:1,routing_hits:1,score:1}],notes:[]})`;
  const env = { ...process.env };
  const procs = ['c1', 'c2', 'c3'].map(s => Bun.spawn([process.execPath, '-e', code, s], { env }));
  await Promise.all(procs.map(p => p.exited));
  const ls = lines();
  expect(ls.length).toBe(3);
  expect(ls.map(l => JSON.parse(l).sid).sort()).toEqual(['c1', 'c2', 'c3']);
});

test('appendRecall writes baseline row when no lesson matched', () => {
  T.appendRecall({ sid: 's2', agent: 'coder', queryHash: 'h', lessons: [], notes: [] });
  expect(JSON.parse(lines()[0]).lessons).toEqual([]);
});

test('appendRecall never stores raw task text', () => {
  const raw = 'SECRET raw task text about refactoring';
  const h = T.hashQuery(raw);
  T.appendRecall({ sid: 's3', agent: 'coder', queryHash: h, lessons: [], notes: [], text: raw, task: raw });
  const content = fs.readFileSync(logPath(), 'utf8');
  expect(content).not.toContain('SECRET');
  expect(content).toContain(h);
});

test('appendRecall caps line at 4000 bytes by truncating notes', () => {
  const notes = Array.from({ length: 200 }, (_, i) => `notes/${'x'.repeat(60)}-${i}.md`);
  T.appendRecall({ sid: 's4', agent: 'coder', queryHash: 'h', lessons: [lesson('lessons/keep.md')], notes });
  const l = lines()[0];
  expect(Buffer.byteLength(l)).toBeLessThanOrEqual(4000);
  const r = JSON.parse(l);
  expect(r.lessons.length).toBe(1);
  expect(r.notes.length).toBeLessThan(200);
});

test('readRecalls skips malformed lines', () => {
  T.appendRecall({ sid: 's5', agent: 'coder', queryHash: 'h', lessons: [], notes: [] });
  fs.appendFileSync(logPath(), 'not json\n{"half":\n');
  T.appendRecall({ sid: 's6', agent: 'coder', queryHash: 'h', lessons: [], notes: [] });
  expect(T.readRecalls().map(r => r.sid)).toEqual(['s5', 's6']);
});

test('verdictForSid reads last result envelope verdict', () => {
  writeOutbox('v1', [
    { seq: 1, type: 'result', body: JSON.stringify({ verdict: 'partial' }) },
    { seq: 2, type: 'progress', body: 'x' },
    { seq: 3, type: 'result', body: JSON.stringify({ verdict: 'complete' }) },
  ]);
  expect(T.verdictForSid('v1')).toBe('complete');
});

test('verdictForSid returns pending when outbox missing', () => {
  expect(T.verdictForSid('nope')).toBe('pending');
});

test('lessonStats computes recall_count last_recalled success_after_recall and baseline', () => {
  const A = 'lessons/a.md', B = 'lessons/b.md';
  const add = (sid, lessons) => T.appendRecall({ sid, agent: 'coder', queryHash: 'h', lessons: lessons.map(p => lesson(p)), notes: [] });
  add('a1', [A]); add('a2', [A, B]); add('a3', [A]); add('a4', [A]);
  add('b1', []); add('b2', []); add('b3', []);
  const res = (sid, verdict) => ({ seq: 1, type: 'result', body: JSON.stringify({ verdict }) });
  writeOutbox('a1', [res('a1', 'complete')]);
  writeOutbox('a2', [res('a2', 'blocked')]);
  writeOutbox('a3', [res('a3', 'complete')]);
  // a4 pending
  writeOutbox('b1', [res('b1', 'complete')]);
  writeOutbox('b2', [res('b2', 'partial')]);
  // b3 pending
  const s = T.lessonStats({ now: Date.now() / 1000 + 10 });
  expect(s.lessons[A].recall_count).toBe(4);
  expect(s.lessons[A].n).toBe(3);
  expect(s.lessons[A].success_after_recall).toBeCloseTo(2 / 3);
  expect(s.lessons[A].last_recalled).toBeGreaterThan(0);
  expect(s.lessons[B].recall_count).toBe(1);
  expect(s.lessons[B].success_after_recall).toBe(0);
  expect(s.baseline.n).toBe(2);
  expect(s.baseline.success_rate).toBeCloseTo(0.5);
});

test('telemetry survives rebuildIndex', () => {
  T.appendRecall({ sid: 's7', agent: 'coder', queryHash: 'h', lessons: [lesson('lessons/a.md')], notes: [] });
  const before = fs.readFileSync(logPath(), 'utf8');
  const code = `require(${JSON.stringify(path.resolve(import.meta.dir, '../lib/vault.js'))}).rebuildIndex()`;
  const r = spawnSync(process.execPath, ['-e', code], { env: process.env, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(fs.readFileSync(logPath(), 'utf8')).toBe(before);
});
