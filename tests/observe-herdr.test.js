'use strict';

// advisor-observe against a herdr runner.json: never judged by tmux paneAlive,
// pane gone + no result -> exit 3 "dead", probe at most once per 5 s per sid.

const { test, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OBS = path.resolve(__dirname, '..', 'bin', 'advisor-observe');
const stops = [];
afterEach(async () => { while (stops.length) await stops.pop()(); });

function baseEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_ENV', 'ADVISOR_HERDR']) {
    if (!(extra && k in extra)) delete env[k];
  }
  return env;
}

function setup(sid, { runner, result } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-herdr-'));
  const runDir = path.join(root, sid);
  const channelDir = path.join(runDir, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  fs.writeFileSync(path.join(channelDir, 'inbox.jsonl'), '');
  fs.writeFileSync(path.join(channelDir, 'outbox.jsonl'),
    result ? JSON.stringify({ seq: 1, type: 'result', body: '{"verdict":"complete"}', from: 'w' }) + '\n' : '');
  if (runner) fs.writeFileSync(path.join(runDir, 'runner.json'), JSON.stringify({ mode: 'herdr', backend: 'herdr', pid: process.pid, ...runner }));
  return root;
}

function runObs(root, sid, extraArgs, env) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', [OBS, sid, '--nudge-after', '0', '--stall-exit', '0', ...extraArgs], {
      env: baseEnv({ ADVISOR_RUNS_ROOT: root, HOME: root, ADVISOR_OBSERVE_TMUX_SOCKET: 'obs-herdr-none', ...env }),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      resolve({ code, lines, ms: Date.now() - t0, exit: lines.filter((l) => l.type === 'observe_exit').pop() });
    });
  });
}

async function fake(panes) {
  const { startFakeHerdr } = await import('./fixtures/herdr-fake-server.js');
  const f = await startFakeHerdr({ panes });
  stops.push(() => f.stop());
  return f;
}
const pane = { pane_id: 'w1:p1', tab_id: 'w1:t1' };
const getCalls = (f) => f.calls.filter((c) => c.method === 'pane.get').length;

test('pane gone and no result -> dead (exit 3) within one probe interval', async () => {
  const f = await fake([]);
  const root = setup('sid-gone', { runner: { pane_id: 'w1:p1' } });
  const r = await runObs(root, 'sid-gone', ['--max-wait', '12'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.exit).toMatchObject({ code: 3, reason: 'dead' });
  expect(r.code).toBe(3);
  expect(r.ms).toBeLessThan(5500);
}, 15000);

test('runner pid dead plus pane gone -> dead', async () => {
  const f = await fake([]);
  const root = setup('sid-pid', { runner: { pane_id: 'w1:p1', pid: 2 ** 22 + 12345 } });
  const r = await runObs(root, 'sid-pid', ['--max-wait', '12'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.exit).toMatchObject({ code: 3, reason: 'dead' });
}, 15000);

test('pane gone but result already in outbox -> normal result exit, not dead', async () => {
  const f = await fake([]);
  const root = setup('sid-res', { runner: { pane_id: 'w1:p1' }, result: true });
  const r = await runObs(root, 'sid-res', ['--max-wait', '6'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.exit).toMatchObject({ code: 0, reason: 'result' });
}, 15000);

test('pane alive -> keeps waiting until max-wait, never dead', async () => {
  const f = await fake([pane]);
  const root = setup('sid-alive', { runner: { pane_id: 'w1:p1' } });
  const r = await runObs(root, 'sid-alive', ['--max-wait', '3'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.exit).toMatchObject({ code: 2, reason: 'timeout' });
  expect(getCalls(f)).toBeGreaterThanOrEqual(1);
}, 15000);

test('socket down (unknown) never produces dead', async () => {
  const root = setup('sid-down', { runner: { pane_id: 'w1:p1' } });
  const r = await runObs(root, 'sid-down', ['--max-wait', '3'], { HERDR_SOCKET_PATH: path.join(root, 'nope.sock') });
  expect(r.exit).toMatchObject({ code: 2, reason: 'timeout' });
}, 15000);

test('probe runs at most once per 5 s per sid', async () => {
  const f = await fake([pane]);
  const root = setup('sid-rate', { runner: { pane_id: 'w1:p1' } });
  const r = await runObs(root, 'sid-rate', ['--max-wait', '7', '--poll', '200'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.exit.reason).toBe('timeout');
  expect(getCalls(f)).toBeGreaterThanOrEqual(1);
  expect(getCalls(f)).toBeLessThanOrEqual(2);
}, 20000);

test('herdr runner is not judged by tmux paneAlive (silent but alive -> busy, not dead)', async () => {
  const f = await fake([pane]);
  const root = setup('sid-busy', { runner: { pane_id: 'w1:p1' } });
  const r = await runObs(root, 'sid-busy', ['--max-wait', '2.5', '--stall-exit', '1'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.lines.some((l) => l.type === 'busy')).toBe(true);
  expect(r.exit.reason).not.toBe('dead');
}, 15000);

test('herdr runner with dead pid -> dead on stall-exit', async () => {
  const f = await fake([pane]);
  const root = setup('sid-deadpid', { runner: { pane_id: 'w1:p1', pid: 2 ** 22 + 12345 } });
  const r = await runObs(root, 'sid-deadpid', ['--max-wait', '4', '--stall-exit', '1'], { HERDR_SOCKET_PATH: f.socketPath });
  expect(r.exit).toMatchObject({ code: 3, reason: 'dead' });
}, 15000);
