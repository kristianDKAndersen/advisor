'use strict';

// advisor-observe exits 4 (reason "question") on a worker `question` so the
// Advisor is woken to answer it. Proves: (a) single sid question -> exit 4;
// (b) two sids, the asking sid is reported; (c) a question at/below the
// --after cursor is ignored; (d) re-arm past the question's seq skips it;
// (e) progress filtering is unchanged and never swallows a question.

const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OBS = path.resolve(__dirname, '..', 'bin', 'advisor-observe');

function setupSids(names) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-question-'));
  const recs = {};
  for (const n of names) {
    const channelDir = path.join(home, '.advisor', 'runs', n, 'channel');
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(path.join(channelDir, 'outbox.jsonl'), '');
    fs.writeFileSync(path.join(channelDir, 'inbox.jsonl'), '');
    recs[n] = { outbox: path.join(channelDir, 'outbox.jsonl') };
  }
  return { home, recs };
}

function appendLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function parseLines(stdout) {
  return stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function runObs(home, args) {
  return spawnSync('node', [OBS, ...args, '--max-wait', '3', '--nudge-after', '0', '--stall-exit', '0'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 8000,
  });
}

test('(a) single sid question: emits the question line then exits 4 reason question', () => {
  const A = 'qA-' + Date.now();
  const { home, recs } = setupSids([A]);
  appendLine(recs[A].outbox, { ts: 1, type: 'question', body: 'push?', from: 'coder', seq: 1 });
  const r = runObs(home, [A]);
  try {
    expect(r.status).toBe(4);
    const lines = parseLines(r.stdout);
    const q = lines.find(l => l.type === 'question');
    expect(q).toBeDefined();
    expect(q.sid).toBe(A);
    expect(q.seq).toBe(1);
    expect(lines[lines.length - 1]).toEqual({ type: 'observe_exit', code: 4, reason: 'question', sid: A });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(b) two sids, B asks: exit 4 with B as the sid', () => {
  const [A, B] = ['qmA-' + Date.now(), 'qmB-' + Date.now()];
  const { home, recs } = setupSids([A, B]);
  appendLine(recs[B].outbox, { ts: 1, type: 'question', body: 'which branch?', from: 'coder', seq: 1 });
  const r = runObs(home, [A, B]);
  try {
    expect(r.status).toBe(4);
    const lines = parseLines(r.stdout);
    const qs = lines.filter(l => l.type === 'question');
    expect(qs.length).toBe(1);
    expect(qs[0].sid).toBe(B);
    const exit = lines[lines.length - 1];
    expect(exit.code).toBe(4);
    expect(exit.reason).toBe('question');
    expect(exit.sid).toBe(B);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(c) a question at or below the --after cursor is ignored', () => {
  const A = 'qcA-' + Date.now();
  const { home, recs } = setupSids([A]);
  appendLine(recs[A].outbox, { ts: 1, type: 'question', body: 'old', from: 'coder', seq: 1 });
  const r = runObs(home, [A, '--after', `${A}:1`]);
  try {
    expect(r.status).toBe(2);
    const lines = parseLines(r.stdout);
    expect(lines.some(l => l.type === 'question')).toBe(false);
    expect(lines[lines.length - 1].reason).toBe('timeout');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(d) re-arm with --after <sid>:<question seq> skips the answered question and reaches the result', () => {
  const [A, B] = ['qdA-' + Date.now(), 'qdB-' + Date.now()];
  const { home, recs } = setupSids([A, B]);
  appendLine(recs[A].outbox, { ts: 1, type: 'question', body: 'ok to delete?', from: 'coder', seq: 1 });
  try {
    const first = runObs(home, [A, B]);
    expect(first.status).toBe(4);
    const q = parseLines(first.stdout).find(l => l.type === 'question');
    appendLine(recs[A].outbox, { ts: 2, type: 'result', body: { summary: 'done', verdict: 'complete', paths: [] }, from: 'coder', seq: 2 });
    const second = runObs(home, [A, B, '--after', `${q.sid}:${q.seq}`]);
    expect(second.status).toBe(0);
    const lines = parseLines(second.stdout);
    expect(lines.some(l => l.type === 'question')).toBe(false);
    expect(lines.find(l => l.type === 'result').sid).toBe(A);
    expect(lines[lines.length - 1].reason).toBe('result');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(e) progress is still filtered without --verbose, but the following question is emitted and exits 4', () => {
  const A = 'qeA-' + Date.now();
  const { home, recs } = setupSids([A]);
  appendLine(recs[A].outbox, { ts: 1, type: 'progress', body: 'working', from: 'coder', seq: 1 });
  appendLine(recs[A].outbox, { ts: 2, type: 'question', body: 'deploy?', from: 'coder', seq: 2 });
  try {
    const quiet = runObs(home, [A]);
    expect(quiet.status).toBe(4);
    const ql = parseLines(quiet.stdout);
    expect(ql.some(l => l.type === 'progress')).toBe(false);
    expect(ql.find(l => l.type === 'question').seq).toBe(2);

    const verbose = runObs(home, [A, '--verbose']);
    expect(verbose.status).toBe(4);
    const vl = parseLines(verbose.stdout);
    expect(vl.some(l => l.type === 'progress' && l.seq === 1)).toBe(true);
    expect(vl.find(l => l.type === 'question').seq).toBe(2);
    expect(vl[vl.length - 1].reason).toBe('question');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
