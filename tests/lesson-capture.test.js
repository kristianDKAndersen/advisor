import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;

let tmpVault;
let tmpRuns;
let lc;
let vault;

beforeAll(async () => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-capture-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-capture-'));
  process.env.ADVISOR_VAULT = tmpVault;
  process.env.ADVISOR_RUNS_ROOT = tmpRuns;
  vault = require('../lib/vault.js');
  lc = require('../lib/lesson-capture.js');
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

beforeEach(() => {
  for (const d of ['lessons', 'synthesis']) fs.rmSync(path.join(tmpVault, d), { recursive: true, force: true });
  for (const f of ['corrections.jsonl', 'lessons.jsonl']) fs.rmSync(path.join(tmpVault, '.cache', f), { force: true });
  for (const d of fs.readdirSync(tmpRuns)) fs.rmSync(path.join(tmpRuns, d), { recursive: true, force: true });
});

const NOW = Date.now();
const nowSec = Math.floor(NOW / 1000);
const sha = s => createHash('sha256').update(s).digest('hex');

function writeSyn({ sid, seq = 1, established = 'coder fixed the parser module', gap = 'none', next = 'proceed', ageDays = 0 }) {
  const ts = NOW / 1000 - ageDays * 86400;
  vault.writeSynthesisNote({
    sid, seq, ts, ts_iso: new Date(ts * 1000).toISOString(), established, gap,
    material: 'yes', next_action: next, key_quotes: '',
  });
  return `synthesis/${sid}-${seq}.md`;
}

function lessonFiles() {
  const dir = path.join(tmpVault, 'lessons');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}

function readLesson(rel) {
  return vault.readNote(rel);
}

function writeCorrections(rows) {
  const dir = path.join(tmpVault, '.cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'corrections.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const corr = (text, over = {}) => ({
  ts: 1790000000 + Math.floor(Math.random() * 1000), sid: 'sess-a', target: 'advisor',
  confidence: 0.75, matched_pattern: 'told-you', text, ...over,
});

function mkRun(sid, { advisorSession, verdicts = [] }) {
  const dir = path.join(tmpRuns, sid);
  fs.mkdirSync(path.join(dir, 'channel'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ sid, advisor_session: advisorSession }));
  const lines = verdicts.map((verdict, i) => JSON.stringify({
    seq: i + 1, type: 'result', from: 'coder', ts: nowSec, body: { verdict, summary: 'test' },
  }));
  fs.writeFileSync(path.join(dir, 'channel', 'outbox.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
}

function runSynthesize(sid) {
  return spawnSync('bun', [CHANNEL_JS, 'synthesize', '--sid', sid, '--seq', '1',
    '--established', 'worker blocked', '--gap', 'none', '--material', 'yes',
    '--next', 'proceed', '--integration-edits', 'none'], {
    encoding: 'utf8', timeout: 25000,
    env: { ...process.env, ADVISOR_VAULT: tmpVault, ADVISOR_RUNS_ROOT: tmpRuns, ADVISOR_SKIP_TAB_CLOSE: '1' },
  });
}

const SIMILAR = [
  'never skip the failing test before editing the module zebracorn',
  'you skipped the failing test before editing the module zebracorn again',
];

test('captureReturnRounds drafts proposed lesson from spawn-refinement next_action', () => {
  const hit = writeSyn({ sid: 'sidr1', gap: 'q'.repeat(600), next: 'Spawn-Refinement with narrower scope' });
  writeSyn({ sid: 'sidr2', gap: 'something missing', next: 'proceed-to-step-8' });
  writeSyn({ sid: 'sidr3', gap: 'old gap', next: 'spawn-refinement', ageDays: 60 });
  const res = lc.captureReturnRounds({ now: NOW });
  expect(res.proposed.length).toBe(1);
  const p = res.proposed[0];
  expect(p.capture_key).toBe(sha('return:' + hit));
  expect(p.source).toBe('return');
  const files = lessonFiles();
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/^proposed-\d{8}-return-[0-9a-f]{8}\.md$/);
  expect(files[0]).toContain(p.capture_key.slice(0, 8));
  const { fm, body } = readLesson('lessons/' + files[0]);
  expect(fm.type).toBe('lesson');
  expect(fm.status).toBe('proposed');
  expect(fm.capture_key).toBe(p.capture_key);
  expect(fm.source).toBe('return');
  expect(fm.audience).toBeUndefined();
  expect(fm.sid).toBe('sidr1');
  expect(body).toContain('## Observed gap');
  expect(body).toContain('q'.repeat(400));
  expect(body).not.toContain('q'.repeat(401));
  expect(body).toContain('Spawn-Refinement with narrower scope');
  expect(body).toMatch(/## Heuristic\s*\n+## Evidence/);
  expect(body).toContain('[[sidr1-1]]');
});

test('captureCorrections requires 2+ similar corrections', () => {
  writeCorrections([corr(SIMILAR[0]), corr('completely unrelated remark about deployment pipelines'),
    corr(SIMILAR[1], { target: 'user' })]);
  expect(lc.captureCorrections({ now: NOW }).proposed.length).toBe(0);
  expect(lessonFiles().length).toBe(0);
  writeCorrections([corr(SIMILAR[0]), corr('completely unrelated remark about deployment pipelines'), corr(SIMILAR[1])]);
  const res = lc.captureCorrections({ now: NOW });
  expect(res.proposed.length).toBe(1);
  expect(res.proposed[0].members.length).toBe(2);
});

test('captureCorrections body never contains correction text', () => {
  writeCorrections([corr(SIMILAR[0], { sid: 'sess-x1', matched_pattern: 'told-you' }),
    corr(SIMILAR[1], { sid: 'sess-x2', matched_pattern: 'told-you' })]);
  const res = lc.captureCorrections({ now: NOW });
  expect(res.proposed.length).toBe(1);
  const raw = fs.readFileSync(path.join(tmpVault, res.proposed[0].path), 'utf8');
  expect(raw).not.toContain('zebracorn');
  expect(raw).not.toContain('failing test');
  expect(raw).toContain('sess-x1');
  expect(raw).toContain('sess-x2');
  expect(raw).toContain('told-you');
});

test('captureGapClusters needs minSize and minSessions', () => {
  const g = 'missing integration coverage for the retry handler path';
  writeSyn({ sid: 'sg1', seq: 1, gap: g });
  writeSyn({ sid: 'sg1', seq: 2, gap: g + ' today' });
  writeSyn({ sid: 'sg1', seq: 3, gap: g });
  expect(lc.captureGapClusters({ now: NOW, dryRun: true }).proposed.length).toBe(0);
  writeSyn({ sid: 'sg2', seq: 1, gap: 'none' });
  writeSyn({ sid: 'sg2', seq: 2, gap: g });
  const res = lc.captureGapClusters({ now: NOW });
  expect(res.proposed.length).toBe(1);
  expect(res.proposed[0].members.length).toBe(4);
  fs.rmSync(path.join(tmpVault, 'lessons'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpVault, 'synthesis', 'sg1-3.md'));
  fs.rmSync(path.join(tmpVault, 'synthesis', 'sg1-2.md'));
  expect(lc.captureGapClusters({ now: NOW, dryRun: true }).proposed.length).toBe(0);
});

test('capture is idempotent via capture_key incl. archive', () => {
  writeSyn({ sid: 'sidi1', gap: 'a gap', next: 'spawn-refinement' });
  const first = lc.captureReturnRounds({ now: NOW });
  expect(first.proposed.length).toBe(1);
  const again = lc.captureReturnRounds({ now: NOW });
  expect(again.proposed.length).toBe(0);
  expect(again.skipped.length).toBe(1);
  expect(lessonFiles().length).toBe(1);
  const f = lessonFiles()[0];
  fs.mkdirSync(path.join(tmpVault, 'lessons', 'archive'), { recursive: true });
  fs.renameSync(path.join(tmpVault, 'lessons', f), path.join(tmpVault, 'lessons', 'archive', f));
  const third = lc.captureReturnRounds({ now: NOW });
  expect(third.proposed.length).toBe(0);
  expect(lessonFiles().length).toBe(0);
});

test('capture dry-run writes nothing', () => {
  writeSyn({ sid: 'sidd1', gap: 'a gap', next: 'spawn-refinement' });
  writeCorrections([corr(SIMILAR[0]), corr(SIMILAR[1])]);
  const r1 = lc.captureReturnRounds({ now: NOW, dryRun: true });
  const r2 = lc.captureCorrections({ now: NOW, dryRun: true });
  expect(r1.proposed.length).toBe(1);
  expect(r2.proposed.length).toBe(1);
  expect(fs.existsSync(path.join(tmpVault, 'lessons'))).toBe(false);
  expect(fs.existsSync(path.join(tmpVault, '.cache', 'lessons.jsonl'))).toBe(false);
});

test('proposed lesson is not recalled', () => {
  writeSyn({ sid: 'sidn1', gap: 'frobnicate the widget registry', next: 'spawn-refinement' });
  vault.writeNote('lessons/control-active.md',
    { type: 'lesson', sid: 'ctl', status: 'active', created_at: new Date().toISOString() },
    '## Heuristic\nfrobnicate the widget registry before release');
  const res = lc.captureReturnRounds({ now: NOW });
  expect(res.proposed.length).toBe(1);
  const hits = vault.searchNotes('frobnicate widget registry', 10, { types: ['lesson'] });
  const byPath = Object.fromEntries(hits.map(h => [h.path, h]));
  expect(byPath['lessons/control-active.md'].status).toBe('active');
  // searchNotes still returns proposed rows at this HEAD; the status marks them as not approved for recall.
  expect(byPath[res.proposed[0].path]?.status ?? 'proposed').toBe('proposed');
  expect(readLesson(res.proposed[0].path).fm.status).toBe('proposed');
});

test('correction and blocked-chain drafts are audience advisor', () => {
  writeCorrections([corr(SIMILAR[0]), corr(SIMILAR[1])]);
  const c = lc.captureCorrections({ now: NOW });
  expect(readLesson(c.proposed[0].path).fm.audience).toBe('advisor');
  const w1 = `${nowSec}-aaa111`, w2 = `${nowSec}-bbb222`;
  mkRun(w1, { advisorSession: 'adv-direct', verdicts: ['blocked'] });
  mkRun(w2, { advisorSession: 'adv-direct', verdicts: ['blocked'] });
  const b = lc.captureBlockedChain({ advisorSession: 'adv-direct', workerSid: w2, now: NOW });
  expect(b.proposed.length).toBe(1);
  const { fm, body } = readLesson(b.proposed[0].path);
  expect(fm.audience).toBe('advisor');
  expect(fm.status).toBe('proposed');
  expect(body).toContain(w1);
  expect(body).toContain(w2);
});

test('2nd blocked verdict across session workers drafts one proposed lesson', () => {
  const w1 = `${nowSec}-aaa111`, w2 = `${nowSec}-bbb222`;
  mkRun(w1, { advisorSession: 'adv-1', verdicts: ['blocked'] });
  mkRun(w2, { advisorSession: 'adv-1', verdicts: ['blocked'] });
  mkRun(`${nowSec}-ccc333`, { advisorSession: 'adv-other', verdicts: ['blocked'] });
  const r = runSynthesize(w2);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('LESSON EXTRACTION REQUIRED');
  expect(r.stdout).toContain('advisor-vault lessons approve');
  const files = lessonFiles().filter(f => f.startsWith('proposed-'));
  expect(files.length).toBe(1);
  expect(r.stdout).toContain(files[0]);
  expect(readLesson('lessons/' + files[0]).fm.status).toBe('proposed');
  // a repeat synthesize for the same chain stays idempotent
  fs.rmSync(path.join(tmpVault, 'synthesis'), { recursive: true, force: true });
  runSynthesize(w2);
  expect(lessonFiles().filter(f => f.startsWith('proposed-')).length).toBe(1);
}, TEST_TIMEOUT);

test('single blocked verdict drafts nothing', () => {
  const w1 = `${nowSec}-aaa111`;
  const oldSid = `${nowSec - 30 * 86400}-ddd444`;
  mkRun(w1, { advisorSession: 'adv-2', verdicts: ['blocked'] });
  mkRun(oldSid, { advisorSession: 'adv-2', verdicts: ['blocked'] });
  mkRun(`${nowSec}-eee555`, { advisorSession: 'adv-2', verdicts: ['complete'] });
  const r = runSynthesize(w1);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(lessonFiles().length).toBe(0);
}, TEST_TIMEOUT);

test('null advisor_session never triggers', () => {
  const w1 = `${nowSec}-aaa111`, w2 = `${nowSec}-bbb222`;
  mkRun(w1, { advisorSession: null, verdicts: ['blocked'] });
  mkRun(w2, { advisorSession: null, verdicts: ['blocked', 'blocked'] });
  const r = runSynthesize(w2);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(lessonFiles().length).toBe(0);
}, TEST_TIMEOUT);

test('6 concurrent captureBlockedChain processes draft exactly one lesson and one audit line', async () => {
  const w1 = `${nowSec}-aaa111`, w2 = `${nowSec}-bbb222`;
  mkRun(w1, { advisorSession: 'adv-race', verdicts: ['blocked'] });
  mkRun(w2, { advisorSession: 'adv-race', verdicts: ['blocked'] });
  const startAt = Date.now() + 1500;
  const script = `
    const lc = require(process.env.LC_PATH);
    while (Date.now() < Number(process.env.START_AT)) {}
    const r = lc.captureBlockedChain({ advisorSession: 'adv-race', workerSid: process.env.W_SID });
    console.log(JSON.stringify({ proposed: r.proposed.length, skipped: r.skipped.length }));
  `;
  const runOne = () => new Promise(resolve => {
    const p = Bun.spawn(['bun', '-e', script], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ADVISOR_VAULT: tmpVault, ADVISOR_RUNS_ROOT: tmpRuns,
        LC_PATH: path.resolve(import.meta.dir, '../lib/lesson-capture.js'), START_AT: String(startAt), W_SID: w2 },
    });
    new Response(p.stdout).text().then(async out => { await p.exited; resolve({ code: p.exitCode, out: out.trim() }); });
  });
  const results = await Promise.all(Array.from({ length: 6 }, runOne));
  for (const r of results) expect(r.code).toBe(0);
  const parsed = results.map(r => JSON.parse(r.out.split('\n').pop()));
  expect(parsed.reduce((n, r) => n + r.proposed, 0)).toBe(1);
  const files = lessonFiles().filter(f => f.startsWith('proposed-'));
  expect(files.length).toBe(1);
  const audit = fs.readFileSync(path.join(tmpVault, '.cache', 'lessons.jsonl'), 'utf8').split('\n').filter(Boolean);
  expect(audit.length).toBe(1);
  const { fm } = readLesson('lessons/' + files[0]);
  expect(fm.status).toBe('proposed');
  expect(fm.audience).toBe('advisor');
  expect(fm.sid).toBe(w2);
  expect(fm.capture_key).toBe(sha('blocked:adv-race'));
}, TEST_TIMEOUT);

test('LESSON_EXISTS from writeLesson is treated as skipped', () => {
  const w1 = `${nowSec}-aaa111`, w2 = `${nowSec}-bbb222`;
  mkRun(w1, { advisorSession: 'adv-exists', verdicts: ['blocked'] });
  mkRun(w2, { advisorSession: 'adv-exists', verdicts: ['blocked'] });
  const orig = vault.writeLesson;
  vault.writeLesson = () => { throw Object.assign(new Error('lesson exists'), { code: 'LESSON_EXISTS' }); };
  let r;
  try {
    r = lc.captureBlockedChain({ advisorSession: 'adv-exists', workerSid: w2, now: NOW });
  } finally { vault.writeLesson = orig; }
  expect(r.proposed.length).toBe(0);
  expect(r.skipped.length).toBe(1);
  expect(r.skipped[0].reason).toBe('exists');
  expect(lessonFiles().length).toBe(0);
});

test('3rd blocked verdict prints already-drafted line', () => {
  const w1 = `${nowSec}-aaa111`, w2 = `${nowSec}-bbb222`, w3 = `${nowSec}-ccc333`;
  mkRun(w1, { advisorSession: 'adv-3', verdicts: ['blocked'] });
  mkRun(w2, { advisorSession: 'adv-3', verdicts: ['blocked'] });
  const first = runSynthesize(w2);
  expect(first.stdout).toContain('LESSON EXTRACTION REQUIRED');
  expect(first.stdout).not.toContain('already drafted');
  const file = lessonFiles().find(f => f.startsWith('proposed-'));
  mkRun(w3, { advisorSession: 'adv-3', verdicts: ['blocked'] });
  const third = runSynthesize(w3);
  expect(third.status).toBe(0);
  expect(third.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(third.stdout).toContain(`LESSON EXTRACTION: already drafted lessons/${file} (blocked_count=3)`);
  expect(lessonFiles().filter(f => f.startsWith('proposed-')).length).toBe(1);
}, TEST_TIMEOUT);

test('capture works with HOME unset', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ROOT: process.env.ADVISOR_RUNS_ROOT };
  delete process.env.HOME; delete process.env.USERPROFILE; delete process.env.ADVISOR_RUNS_ROOT;
  try {
    expect(lc.runsRoot()).toBe(path.join(os.homedir(), '.advisor', 'runs'));
  } finally {
    for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['ADVISOR_RUNS_ROOT', saved.ROOT]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
