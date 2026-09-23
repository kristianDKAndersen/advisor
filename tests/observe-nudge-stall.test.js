'use strict';

// Regression tests for the observe defects fixed by this change:
// (1) pipe-safe observe_exit line so a piped consumer sees the true outcome/code
// (2) one-time status nudge to the inbox after --nudge-after seconds of TRUE silence
// (3) exit code 3 after --stall-exit seconds of TRUE silence (orchestrator decides)
// (4) live heartbeats suppress both the nudge and the stalled/stall-exit paths
// (5) ADVISOR_RUNS_ROOT is honored instead of hardcoding $HOME

const { test, expect, afterAll } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const OBS = path.resolve(__dirname, '..', 'bin', 'advisor-observe');

// Isolated tmux server (-L socket unique to this process) — busy/dead detection
// tests below must never touch the shared/default tmux server other sessions use.
let tmuxAvailable = true;
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch (_) { tmuxAvailable = false; }
const OBS_SOCKET = `obstest-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const tmuxIso = (...args) =>
  execFileSync('tmux', ['-L', OBS_SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

if (tmuxAvailable) {
  tmuxIso('new-session', '-d', '-s', 'keeper');
}

afterAll(() => {
  if (!tmuxAvailable) return;
  try { execFileSync('tmux', ['-L', OBS_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch (_) {}
});

const tIso = tmuxAvailable ? test : test.skip;

function writeRunnerRecord(root, sid, record) {
  fs.writeFileSync(path.join(root, sid, 'runner.json'), JSON.stringify(record));
}

function setupSid(root, name) {
  const channelDir = path.join(root, name, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const outboxPath = path.join(channelDir, 'outbox.jsonl');
  const inboxPath = path.join(channelDir, 'inbox.jsonl');
  fs.writeFileSync(outboxPath, '');
  fs.writeFileSync(inboxPath, '');
  return { channelDir, outboxPath, inboxPath, heartbeatPath: path.join(channelDir, 'heartbeat.jsonl') };
}

function appendLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function parseLines(stdout) {
  return stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ── (1) pipe-safe observe_exit line ──────────────────────────────────────────

test('observe_exit line with code 1 survives a shell pipe for a blocked result', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-pipe-'));
  const sid = 'pipe-' + Date.now();
  const rec = setupSid(path.join(home, '.advisor', 'runs'), sid);
  appendLine(rec.outboxPath, { ts: 1, type: 'result', body: { summary: 'nope', verdict: 'blocked', paths: [] }, from: 'worker', seq: 1 });

  const r = spawnSync('sh', ['-c', `node "${OBS}" ${sid} --max-wait 3 | cat`], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 6000,
  });
  try {
    const lines = parseLines(r.stdout);
    const exitLine = lines.find(l => l.type === 'observe_exit');
    expect(exitLine).toBeDefined();
    expect(exitLine.code).toBe(1);
    expect(exitLine.reason).toBe('blocked');
    expect(exitLine.sid).toBe(sid);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── (2) nudge written exactly once ───────────────────────────────────────────

test('nudge is appended to the inbox exactly once after --nudge-after seconds of true silence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-nudge-'));
  const sid = 'nudge-' + Date.now();
  const rec = setupSid(path.join(home, '.advisor', 'runs'), sid);

  const r = spawnSync('node', [OBS, sid, '--nudge-after', '1', '--stall-exit', '0', '--max-wait', '3'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 6000,
  });
  try {
    const lines = parseLines(r.stdout);
    expect(lines.filter(l => l.type === 'nudged').length).toBe(1);
    const inboxMsgs = fs.readFileSync(rec.inboxPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const guidance = inboxMsgs.filter(m => m.type === 'guidance' && m.from === 'advisor-observe');
    expect(guidance.length).toBe(1);
    expect(guidance[0].body).toBe('status?');
    expect(r.status).toBe(2); // max-wait timeout after the nudge
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── (3) exit 3 on total silence ──────────────────────────────────────────────

test('exits 3 after --stall-exit seconds of true silence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-stallexit-'));
  const sid = 'stallexit-' + Date.now();
  setupSid(path.join(home, '.advisor', 'runs'), sid);

  const r = spawnSync('node', [OBS, sid, '--nudge-after', '0', '--stall-exit', '1', '--max-wait', '10'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 6000,
  });
  try {
    expect(r.status).toBe(3);
    const lines = parseLines(r.stdout);
    expect(lines.some(l => l.type === 'stalled')).toBe(true);
    const exitLine = lines.find(l => l.type === 'observe_exit');
    expect(exitLine.code).toBe(3);
    expect(exitLine.reason).toBe('stalled');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── (4) live heartbeats suppress nudge and stalled ───────────────────────────

test('no nudge and no stalled line while heartbeat.jsonl stays live', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-live-'));
  const sid = 'live-' + Date.now();
  const rec = setupSid(path.join(home, '.advisor', 'runs'), sid);

  const child = spawn('node', [OBS, sid, '--nudge-after', '1', '--stall-exit', '2', '--max-wait', '5'], {
    env: { ...process.env, HOME: home },
  });
  let out = '';
  child.stdout.on('data', d => (out += d.toString()));

  let toolCount = 0;
  const iv = setInterval(() => {
    appendLine(rec.heartbeatPath, { ts: Date.now() / 1000, tool_count: ++toolCount });
  }, 300);

  await new Promise(resolve => setTimeout(resolve, 3800));
  clearInterval(iv);
  child.kill();

  try {
    expect(out.includes('"type":"nudged"')).toBe(false);
    expect(out.includes('"type":"stalled"')).toBe(false);
    const inboxMsgs = fs.readFileSync(rec.inboxPath, 'utf8').split('\n').filter(l => l.trim());
    expect(inboxMsgs.length).toBe(0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 8000);

// ── (5) ADVISOR_RUNS_ROOT honored ────────────────────────────────────────────

// ── (6) runner.json alive -> busy, then exit 3 'stalled' only at 3x --stall-exit ──

tIso('busy: alive runner+pane emits busy at 1x stall-exit and keeps waiting, exits 3 stalled at 3x', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-busy-'));
  const sid = 'busy-' + Date.now();
  const runsDir = path.join(home, '.advisor', 'runs');
  setupSid(runsDir, sid);

  const paneId = tmuxIso('new-window', '-d', '-t', 'keeper', '-P', '-F', '#{pane_id}').trim();
  writeRunnerRecord(runsDir, sid, { pid: process.pid, mode: 'multiplex', pane_id: paneId, started_at: Date.now() });

  const start = Date.now();
  const r = spawnSync('node', [OBS, sid, '--nudge-after', '0', '--stall-exit', '1', '--max-wait', '6'], {
    env: { ...process.env, HOME: home, ADVISOR_OBSERVE_TMUX_SOCKET: OBS_SOCKET }, encoding: 'utf8', timeout: 10000,
  });
  const elapsed = Date.now() - start;
  try {
    const lines = parseLines(r.stdout);
    expect(lines.some(l => l.type === 'busy')).toBe(true);
    expect(elapsed).toBeGreaterThan(2000); // must not exit at the 1x mark
    expect(r.status).toBe(3);
    const exitLine = lines.find(l => l.type === 'observe_exit');
    expect(exitLine.reason).toBe('stalled');
  } finally {
    try { tmuxIso('kill-pane', '-t', paneId); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 12000);

tIso('dead: runner.json pane is gone exits 3 dead promptly (well before 3x --stall-exit)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dead-'));
  const sid = 'dead-' + Date.now();
  const runsDir = path.join(home, '.advisor', 'runs');
  setupSid(runsDir, sid);

  const paneId = tmuxIso('new-window', '-d', '-t', 'keeper', '-P', '-F', '#{pane_id}').trim();
  tmuxIso('kill-pane', '-t', paneId);
  writeRunnerRecord(runsDir, sid, { pid: process.pid, mode: 'multiplex', pane_id: paneId, started_at: Date.now() });

  const start = Date.now();
  const r = spawnSync('node', [OBS, sid, '--nudge-after', '0', '--stall-exit', '1', '--max-wait', '6'], {
    env: { ...process.env, HOME: home, ADVISOR_OBSERVE_TMUX_SOCKET: OBS_SOCKET }, encoding: 'utf8', timeout: 10000,
  });
  const elapsed = Date.now() - start;
  try {
    expect(r.status).toBe(3);
    const lines = parseLines(r.stdout);
    const exitLine = lines.find(l => l.type === 'observe_exit');
    expect(exitLine.reason).toBe('dead');
    expect(elapsed).toBeLessThan(2500); // must not wait for the 3x threshold (~3s)
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 12000);

// ── (7) N1: distinct observe_exit reasons for code 2 ─────────────────────────

test("[N1] exit 2 reason is 'usage' for a zero-sid invocation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-n1-usage1-'));
  const r = spawnSync('node', [OBS], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 4000 });
  try {
    expect(r.status).toBe(2);
    const lines = parseLines(r.stdout);
    const exitLine = lines.find(l => l.type === 'observe_exit');
    expect(exitLine.reason).toBe('usage');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("[N1] exit 2 reason is 'usage' for an ambiguous bare --after with 2+ sids", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-n1-usage2-'));
  const runsDir = path.join(home, '.advisor', 'runs');
  setupSid(runsDir, 'sidA');
  setupSid(runsDir, 'sidB');
  const r = spawnSync('node', [OBS, 'sidA', 'sidB', '--after', '5'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 4000,
  });
  try {
    expect(r.status).toBe(2);
    const lines = parseLines(r.stdout);
    const exitLine = lines.find(l => l.type === 'observe_exit');
    expect(exitLine.reason).toBe('usage');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ADVISOR_RUNS_ROOT is honored instead of hardcoding $HOME', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-runsroot-'));
  const sid = 'runsroot-' + Date.now();
  const rec = setupSid(runsRoot, sid);
  appendLine(rec.outboxPath, { ts: 1, type: 'result', body: { summary: 'ok', verdict: 'complete', paths: [] }, from: 'worker', seq: 1 });

  const wrongHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-wronghome-'));
  const r = spawnSync('node', [OBS, sid, '--max-wait', '2'], {
    env: { ...process.env, HOME: wrongHome, ADVISOR_RUNS_ROOT: runsRoot }, encoding: 'utf8', timeout: 4000,
  });
  try {
    expect(r.status).toBe(0);
    const lines = parseLines(r.stdout);
    expect(lines.some(l => l.type === 'result')).toBe(true);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(wrongHome, { recursive: true, force: true });
  }
});
