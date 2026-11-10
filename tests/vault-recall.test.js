import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const vault = require('../lib/vault');
const { recallForTask, recallLessonsForAdvisor } = require('../lib/vault-recall');
const { composeTaskBody } = require('../lib/summon');
const { readRecalls } = require('../lib/recall-telemetry');

const TASK = 'Plan the payment gateway migration rollout for the billing service.';
const LESSON_HEADING = '## Prior lessons (auto-recall)';
const NOTES_HEADING = '## Prior vault context (auto-recall)';

let vaultRoot;
let runsRoot;

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-recall-lib-'));
  runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-recall-runs-'));
  process.env.ADVISOR_VAULT = vaultRoot;
  process.env.ADVISOR_RUNS_ROOT = runsRoot;
  delete process.env.ADVISOR_VAULT_RECALL;
});

afterEach(() => {
  delete process.env.ADVISOR_VAULT_RECALL;
  delete process.env.ADVISOR_RUNS_ROOT;
  fs.rmSync(vaultRoot, { recursive: true, force: true });
  fs.rmSync(runsRoot, { recursive: true, force: true });
});

function mkLesson(name, opts = {}) {
  const {
    tags = 'payment gateway migration',
    status,
    audience,
    heuristic = `Stage the ${name} rollout behind a flag.`,
    created_at = new Date().toISOString(),
    body,
  } = opts;
  const fm = { type: 'lesson', sid: 'S-' + name, agent: 'coder', created_at, task_type: 'coder', tags };
  if (status !== undefined) fm.status = status;
  if (audience !== undefined) fm.audience = audience;
  const text = body !== undefined ? body : [
    `Tags: ${tags}`,
    '## Root cause\nThe payment gateway migration rollout skipped staging.',
    `## Heuristic\n${heuristic}`,
    '## Evidence\nSynthesis seq: 1',
  ].join('\n\n');
  vault.writeNote(`lessons/${name}.md`, fm, text);
  return `lessons/${name}.md`;
}

function mkSynthesis(n) {
  vault.writeSynthesisNote({
    sid: `NOTE-SID-${n}`, seq: 1, ts: Date.now() / 1000, ts_iso: new Date().toISOString(),
    established: 'Migrating the payment gateway requires a staged rollout plan for billing.',
    gap: 'none', material: 'no', next_action: 'proceed', key_quotes: '',
  });
}

const names = hits => hits.map(h => h.name).sort();

test('recallForTask returns lessons and notes in separate arrays', () => {
  mkLesson('lesson-a');
  mkSynthesis(1);
  const r = recallForTask(TASK);
  expect(names(r.lessons)).toEqual(['lesson-a']);
  expect(r.notes.length).toBeGreaterThan(0);
  expect(r.notes.every(n => !n.path.startsWith('lessons/'))).toBe(true);
  const l = r.lessons[0];
  expect(l.path).toBe('lessons/lesson-a.md');
  expect(l.absPath).toBe(path.join(vaultRoot, 'lessons/lesson-a.md'));
  expect(l.routing_hits).toBeGreaterThanOrEqual(2);
  expect(typeof l.score).toBe('number');
  expect(l.heuristic).toContain('Stage the lesson-a rollout');
});

test('recallForTask caps lessons at 2 and notes at 2', () => {
  for (const n of ['l1', 'l2', 'l3']) mkLesson(n);
  for (const n of [1, 2, 3]) mkSynthesis(n);
  const r = recallForTask(TASK);
  expect(r.lessons.length).toBe(2);
  expect(r.notes.length).toBe(2);
});

test('recallForTask excludes proposed promoted retired archived lessons', () => {
  mkLesson('l-active', { status: 'active' });
  for (const s of ['proposed', 'promoted', 'retired', 'archived']) mkLesson('l-' + s, { status: s });
  const r = recallForTask(TASK, { lessonLimit: 10 });
  expect(names(r.lessons)).toEqual(['l-active']);
});

test('recallForTask treats status-less and stale lesson as active', () => {
  mkLesson('l-none');
  mkLesson('l-stale', { status: 'stale' });
  const r = recallForTask(TASK, { lessonLimit: 10 });
  expect(names(r.lessons)).toEqual(['l-none', 'l-stale']);
});

test('lesson lane applies no recency decay', () => {
  mkLesson('l-old', { created_at: '2020-01-01T00:00:00.000Z' });
  mkLesson('l-new');
  const r = recallForTask(TASK, { lessonLimit: 10 });
  expect(names(r.lessons)).toEqual(['l-new', 'l-old']);
  const [a, b] = r.lessons;
  expect(Math.abs(a.score - b.score)).toBeLessThan(1e-9);
});

test('lesson below routing-hit floor is not recalled', () => {
  // Body matches many query tokens; routing matches only one.
  mkLesson('l-weak', { tags: 'payment' });
  const r = recallForTask(TASK, { lessonLimit: 10 });
  expect(r.lessons).toEqual([]);
});

test('lesson recalled on a 1-note vault', () => {
  mkLesson('l-only');
  const r = recallForTask(TASK);
  expect(names(r.lessons)).toEqual(['l-only']);
  expect(r.lessons[0].score).toBeGreaterThan(0);
});

test('heuristic section extracted and capped at 600 chars', () => {
  mkLesson('l-long', { heuristic: 'word '.repeat(300) });
  const r = recallForTask(TASK, { lessonLimit: 10 });
  const long = r.lessons.find(l => l.name === 'l-long');
  expect(long.heuristic.length).toBe(600);
  expect(long.heuristic.startsWith('word word')).toBe(true);
  expect(long.heuristic).not.toContain('Synthesis seq');
});

test('non-ASCII task text does not throw and still matches ASCII tags', () => {
  mkLesson('l-ascii');
  let r;
  expect(() => {
    r = recallForTask('Plan the payment gateway migration för kunden: résumé 日本語 ☃ ñandú');
  }).not.toThrow();
  expect(names(r.lessons)).toEqual(['l-ascii']);
});

test('worker lane excludes audience=advisor lessons', () => {
  mkLesson('l-adv', { audience: 'advisor' });
  mkLesson('l-wrk', { audience: 'worker' });
  mkLesson('l-both', { audience: 'both' });
  const r = recallForTask(TASK, { lessonLimit: 10 });
  expect(names(r.lessons)).toEqual(['l-both', 'l-wrk']);
});

test('missing audience treated as both', () => {
  mkLesson('l-legacy');
  expect(names(recallForTask(TASK).lessons)).toEqual(['l-legacy']);
  expect(names(recallLessonsForAdvisor(TASK))).toEqual(['l-legacy']);
});

test('unknown audience value is excluded from both lanes', () => {
  mkLesson('l-typo', { audience: 'advisors' });
  mkLesson('l-none', { audience: 'none' });
  mkLesson('l-both', { audience: 'both' });
  expect(names(recallForTask(TASK, { lessonLimit: 10 }).lessons)).toEqual(['l-both']);
  expect(names(recallLessonsForAdvisor(TASK, { limit: 10 }))).toEqual(['l-both']);
});

test('lesson with empty heuristic is not recalled', () => {
  mkLesson('l-empty', { heuristic: '' });
  mkLesson('l-nosection', { body: 'Tags: payment gateway migration\n\n## Root cause\nNo heuristic here.' });
  mkLesson('l-ok');
  expect(names(recallForTask(TASK, { lessonLimit: 10 }).lessons)).toEqual(['l-ok']);
  expect(names(recallLessonsForAdvisor(TASK, { limit: 10 }))).toEqual(['l-ok']);
});

test('lesson-lane failure logs to stderr and returns notes', () => {
  mkLesson('l-ok');
  mkSynthesis(1);
  expect(recallForTask(TASK).notes.length).toBeGreaterThan(0);
  const dbFile = path.join(vault.vaultRoot(), '.cache', 'vault.db');
  fs.chmodSync(dbFile, 0o000);
  const orig = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  let r;
  try { r = recallForTask(TASK); } finally { console.error = orig; }
  expect(r.lessons).toEqual([]);
  expect(r.notes.length).toBeGreaterThan(0);
  expect(logged.some(l => l.startsWith('[vault] lesson recall failed: '))).toBe(true);
});

test('recallLessonsForAdvisor returns advisor and both lessons only', () => {
  mkLesson('l-adv', { audience: 'advisor' });
  mkLesson('l-wrk', { audience: 'worker' });
  mkLesson('l-both', { audience: 'both' });
  mkLesson('l-proposed', { audience: 'advisor', status: 'proposed' });
  const hits = recallLessonsForAdvisor(TASK, { limit: 10 });
  expect(names(hits)).toEqual(['l-adv', 'l-both']);
  expect(recallLessonsForAdvisor(TASK, { limit: 1 }).length).toBe(1);
  expect(readRecalls()).toEqual([]);
});

test('lesson and note sections are separate headings', () => {
  mkLesson('l-sep');
  mkSynthesis(1);
  const body = composeTaskBody({ sid: 'recall-sep-1', task: TASK, goal: 'g', agent: 'coder' });
  const li = body.indexOf(LESSON_HEADING);
  const ni = body.indexOf(NOTES_HEADING);
  expect(li).toBeGreaterThan(-1);
  expect(ni).toBeGreaterThan(li);
  const lessonSection = body.slice(li, ni);
  const notesSection = body.slice(ni);
  const absPath = path.join(vaultRoot, 'lessons/l-sep.md');
  expect(lessonSection).toContain(`- **l-sep**: Stage the l-sep rollout behind a flag. — ${absPath}`);
  expect(notesSection).not.toContain('l-sep');
  expect(notesSection).toContain('NOTE-SID-1-1');
});

test('notes section heading unchanged', () => {
  mkSynthesis(1);
  const body = composeTaskBody({ sid: 'recall-notes-1', task: TASK, goal: 'g', agent: 'coder' });
  expect(body).toContain(NOTES_HEADING);
  expect(body).not.toContain(LESSON_HEADING);
  expect(body).toMatch(/- \*\*NOTE-SID-1-1\*\* \(synthesis\): [\s\S]+ — .*NOTE-SID-1-1\.md/);
});

test('recall logs telemetry row', () => {
  mkLesson('l-tel');
  mkSynthesis(1);
  composeTaskBody({ sid: 'recall-tel-1', task: TASK, goal: 'g', agent: 'coder' });
  const rows = readRecalls();
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row.sid).toBe('recall-tel-1');
  expect(row.agent).toBe('coder');
  expect(row.query_hash).toMatch(/^sha256:[0-9a-f]{16}$/);
  expect(row.lessons.length).toBe(1);
  expect(row.lessons[0].path).toBe('lessons/l-tel.md');
  expect(row.lessons[0].rank).toBe(1);
  expect(row.lessons[0].routing_hits).toBeGreaterThanOrEqual(2);
  expect(row.notes.length).toBeGreaterThan(0);
  expect(row.notes.every(p => typeof p === 'string' && !p.startsWith('lessons/'))).toBe(true);
});

test('ADVISOR_VAULT_RECALL=0 writes no telemetry', () => {
  mkLesson('l-off');
  process.env.ADVISOR_VAULT_RECALL = '0';
  const body = composeTaskBody({ sid: 'recall-off-1', task: TASK, goal: 'g', agent: 'coder' });
  expect(body).not.toContain(LESSON_HEADING);
  expect(readRecalls()).toEqual([]);
  expect(fs.existsSync(path.join(vaultRoot, '.cache', 'recall.jsonl'))).toBe(false);
});

test('meta.json records advisor_session and continues', () => {
  const SUMMON_JS = path.join(import.meta.dir, '..', 'lib', 'summon.js');
  const run = (sid, extra, env) => {
    const r = spawnSync('node', [SUMMON_JS, '--agent', 'researcher', '--task', 'meta linkage test', '--goal', 'done', '--sid', sid, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, ...env, ADVISOR_RUNS_ROOT: runsRoot, ADVISOR_VAULT: vaultRoot },
    });
    expect(r.status).toBe(0);
    return JSON.parse(fs.readFileSync(path.join(runsRoot, sid, 'meta.json'), 'utf8'));
  };
  const withLink = run('1700000010-aaaa01', ['--continues', '1700000009-bbbb02'], { CLAUDE_CODE_SESSION_ID: 'adv-sess-123' });
  expect(withLink.advisor_session).toBe('adv-sess-123');
  expect(withLink.continues).toBe('1700000009-bbbb02');
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  const without = (() => {
    const sid = '1700000011-cccc03';
    const r = spawnSync('node', [SUMMON_JS, '--agent', 'researcher', '--task', 'meta linkage test', '--goal', 'done', '--sid', sid], {
      encoding: 'utf8',
      env: { ...env, ADVISOR_RUNS_ROOT: runsRoot, ADVISOR_VAULT: vaultRoot },
    });
    expect(r.status).toBe(0);
    return JSON.parse(fs.readFileSync(path.join(runsRoot, sid, 'meta.json'), 'utf8'));
  })();
  expect(without.advisor_session).toBeNull();
  expect(without.continues).toBeNull();
}, 60000);

const { sanitizeRecallQuery } = require('../lib/vault-recall');
const queryWords = text => sanitizeRecallQuery(text).split(' OR ').filter(Boolean);

test('path segments do not consume query budget', () => {
  const text = 'Check /Users/someone/dev/team/project/lib/a.js and ./src/deep/b.ts and ~/notes/c.md then audit merge origin branch state';
  const words = queryWords(text).map(w => w.toLowerCase());
  expect(words).toEqual(['check', 'audit', 'merge', 'origin', 'branch', 'state']);
});

test('urls and shas are stripped from query', () => {
  const text = 'Review https://example.com/a/b?x=1 at commit 9fceb02d0ae598e95dc970b74767f19372d61af8 sid 1794293886-8ef770 using $ADV and ${OUTPUT_DIR} <objective>alpha</objective> beta';
  const words = queryWords(text).map(w => w.toLowerCase());
  expect(words).toEqual(['review', 'commit', 'sid', 'using', 'alpha', 'beta']);
  expect(queryWords('a decade defaced cafe')).toEqual(['decade', 'defaced', 'cafe']);
});

test('duplicate tokens counted once', () => {
  expect(queryWords('Merge merge MERGE origin Origin branch')).toEqual(['Merge', 'origin', 'branch']);
  const words = queryWords(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  expect(words.length).toBeLessThanOrEqual(30);
  expect(words.length).toBeGreaterThanOrEqual(15);
});

test('brief with absolute path still recalls matching lesson', () => {
  mkLesson('l-merge', { tags: 'merge origin branch stale' });
  const brief = '<objective>Report whether local branch feat/vault-lessons in /Users/someone/dev/devtest/advisor is ahead of master and the git merge state versus origin, stale or not</objective>';
  const r = recallForTask(brief);
  expect(names(r.lessons)).toEqual(['l-merge']);
  expect(Array.isArray(r.notes)).toBe(true);
});
