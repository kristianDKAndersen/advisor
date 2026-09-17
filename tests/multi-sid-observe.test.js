'use strict';

// Multi-sid advisor-observe: one process watches N sids in one loop.
// Proves: (a) first terminal across the fleet emits+exits with that sid;
// (b) per-sid stall isolation + display-only progress filter;
// (c) bare numeric --after with 2+ sids is a usage error, repeatable
//     --after sid:seq honored per sid; (d) pre-existing terminal for one sid
//     is emitted but does NOT short-circuit the fleet while others are live.

const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { persistTerminal } = require('../lib/terminal-persist.js');

const OBS = path.resolve(__dirname, '..', 'bin', 'advisor-observe');

function setupSids(names) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sid-'));
  const recs = {};
  for (const n of names) {
    const channelDir = path.join(home, '.advisor', 'runs', n, 'channel');
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(path.join(channelDir, 'outbox.jsonl'), '');
    fs.writeFileSync(path.join(channelDir, 'inbox.jsonl'), '');
    recs[n] = {
      channelDir,
      outbox: path.join(channelDir, 'outbox.jsonl'),
      inbox: path.join(channelDir, 'inbox.jsonl'),
    };
  }
  return { home, recs };
}

function appendLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function parseLines(stdout) {
  return stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ── (a) first terminal across the fleet emits its sid and exits ─────────────

test('(a) result on B makes the single process emit B and exit; A and C emit nothing terminal', () => {
  const [A, B, C] = ['obsA-' + Date.now(), 'obsB-' + Date.now(), 'obsC-' + Date.now()];
  const { home, recs } = setupSids([A, B, C]);
  appendLine(recs[B].outbox, { ts: 1, type: 'result', body: { summary: 'b done', verdict: 'complete', paths: [] }, from: 'worker', seq: 1 });

  const r = spawnSync('node', [OBS, A, B, C, '--max-wait', '5'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 8000,
  });
  try {
    expect(r.status).toBe(0);
    const lines = parseLines(r.stdout);
    const results = lines.filter(l => l.type === 'result');
    expect(results.length).toBe(1);
    expect(results[0].sid).toBe(B);
    expect(lines.some(l => l.sid === A && (l.type === 'result' || l.type === 'error'))).toBe(false);
    expect(lines.some(l => l.sid === C && (l.type === 'result' || l.type === 'error'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── (b) per-sid stall isolation + display-only progress filter (real-time) ──

test('(b) traffic on A does not suppress a stalled line for silent C; A progress is filtered from stdout', async () => {
  const [A, B, C] = ['stA-' + Date.now(), 'stB-' + Date.now(), 'stC-' + Date.now()];
  const { home, recs } = setupSids([A, B, C]);

  const child = spawn('node', [OBS, A, B, C, '--max-wait', '90'], {
    env: { ...process.env, HOME: home },
  });
  let out = '';
  child.stdout.on('data', d => (out += d.toString()));

  // Keep A chatty with progress every 5s (filtered from stdout, but must reset A's stall timer).
  let seqA = 0;
  const iv = setInterval(() => {
    appendLine(recs[A].outbox, { ts: Date.now() / 1000, type: 'progress', body: 'tick', from: 'worker', seq: ++seqA });
  }, 5000);

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (out.includes('"type":"stalled"') && out.includes(`"sid":"${C}"`)) {
        clearInterval(check); resolve();
      }
    }, 500);
    setTimeout(() => { clearInterval(check); resolve(); }, 78000);
  });

  clearInterval(iv);
  child.kill();

  try {
    const stalled = out.split('\n').filter(l => l.includes('"type":"stalled"'));
    expect(stalled.some(l => l.includes(`"sid":"${C}"`))).toBe(true); // C stalled
    expect(stalled.some(l => l.includes(`"sid":"${A}"`))).toBe(false); // A never stalled
    expect(out.includes('"type":"progress"')).toBe(false);            // A's progress filtered
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 90000);

// ── (c) --after cursor forms ────────────────────────────────────────────────

test('(c1) bare numeric --after with 2+ sids is a usage error (exit 2) naming the correct form', () => {
  const [A, B] = ['caA-' + Date.now(), 'caB-' + Date.now()];
  const { home } = setupSids([A, B]);
  const r = spawnSync('node', [OBS, A, B, '--after', '5', '--max-wait', '2'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 4000,
  });
  try {
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--after <sid>:<seq>');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(c2) repeatable --after sid:seq cursors are honored per sid', () => {
  const [A, B] = ['cbA-' + Date.now(), 'cbB-' + Date.now()];
  const { home, recs } = setupSids([A, B]);
  // A already has a result at seq 1 that must be skipped because cursor A = 1.
  appendLine(recs[A].outbox, { ts: 1, type: 'result', body: { summary: 'a old', verdict: 'complete', paths: [] }, from: 'w', seq: 1 });
  appendLine(recs[B].outbox, { ts: 1, type: 'result', body: { summary: 'b', verdict: 'complete', paths: [] }, from: 'w', seq: 1 });

  const r = spawnSync('node', [OBS, A, B, '--after', `${A}:1`, '--after', `${B}:0`, '--max-wait', '5'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 8000,
  });
  try {
    expect(r.status).toBe(0);
    const results = parseLines(r.stdout).filter(l => l.type === 'result');
    expect(results.length).toBe(1);
    expect(results[0].sid).toBe(B); // A's seq-1 result was below its cursor and skipped
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── (d) pre-existing terminal must not short-circuit the fleet ───────────────

test('(d) a pre-existing terminal for one of three sids is emitted but the process keeps watching the live two', () => {
  const [A, B, C] = ['tmA-' + Date.now(), 'tmB-' + Date.now(), 'tmC-' + Date.now()];
  const { home, recs } = setupSids([A, B, C]);
  persistTerminal(recs[A].channelDir, { seq: 7, type: 'result', body: { summary: 'a term', verdict: 'complete', paths: [] }, ts: Date.now() / 1000 });

  const r = spawnSync('node', [OBS, A, B, C, '--max-wait', '2'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5000,
  });
  try {
    expect(r.status).toBe(2); // timed out on live B/C => did NOT exit on A's terminal
    const lines = parseLines(r.stdout);
    expect(lines.some(l => l.sid === A && l.seq === 7)).toBe(true); // A's terminal was emitted
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── structural: one process, one loop — no self-spawn or fork ────────────────

test('bin/advisor-observe contains no self-spawn or fork (only close-worker-tab spawnSync)', () => {
  const src = fs.readFileSync(OBS, 'utf8');
  expect(src).not.toContain('fork(');
  expect(src).not.toContain('.fork');
  const spawnCalls = src.match(/spawnSync\(/g) || [];
  expect(spawnCalls.length).toBe(1); // the single close-worker-tab call
});
