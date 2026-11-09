import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { startFakeHerdr } from './fixtures/herdr-fake-server.js';

const REPO = path.resolve(import.meta.dir, '..');
const CLOSE_TAB = path.join(REPO, 'bin', 'close-tab');
const SID = '1794229583-b3d0c7';
const PANE = 'w1:p2';

let tmpDir;
let fake;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-tab-herdr-'));
});

afterEach(async () => {
  if (fake) await fake.stop();
  fake = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseEnv() {
  const env = { ...process.env, HOME: tmpDir, ADVISOR_RUNS_ROOT: path.join(tmpDir, 'runs') };
  for (const k of ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_ENV',
    'ADVISOR_HERDR', 'ADVISOR_WORKER_BACKEND', 'ADVISOR_SID', 'ADVISOR_TMUX', 'ADVISOR_TMUX_MULTIPLEX', 'TMUX', 'TMUX_PANE']) {
    delete env[k];
  }
  return env;
}

function herdrEnv(extra = {}) {
  return {
    ...baseEnv(),
    HERDR_ENV: '1',
    HERDR_PANE_ID: PANE,
    ADVISOR_WORKER_BACKEND: 'herdr',
    ADVISOR_SID: SID,
    HERDR_SOCKET_PATH: fake.socketPath,
    ...extra,
  };
}

// Async: the fake server shares this event loop, so a sync spawn would starve it.
function runCloseTab(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [CLOSE_TAB], { env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (status) => { clearTimeout(timer); resolve({ status }); });
  });
}

const closes = () => fake.calls.filter((c) => c.method === 'pane.close');

test('token match closes exactly the own pane', async () => {
  fake = await startFakeHerdr({ panes: [{ pane_id: PANE, tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
  const r = await runCloseTab(herdrEnv());
  expect(r.status).toBe(0);
  expect(closes()).toEqual([{ method: 'pane.close', params: { pane_id: PANE } }]);
});

test('token mismatch sends no pane.close', async () => {
  fake = await startFakeHerdr({
    panes: [{ pane_id: PANE, tab_id: 'w1:t1', tokens: { advisor_sid: 'other-sid' } }],
  });
  const r = await runCloseTab(herdrEnv());
  expect(r.status).toBe(0);
  expect(fake.calls.length).toBeGreaterThan(0);
  expect(closes()).toHaveLength(0);
});

test('foreign pane in the same tab is untouched', async () => {
  fake = await startFakeHerdr({
    panes: [
      { pane_id: PANE, tab_id: 'w1:t1', tokens: { advisor_sid: SID } },
      { pane_id: 'w1:p3', tab_id: 'w1:t1', tokens: { advisor_sid: 'other-sid' } },
    ],
  });
  await runCloseTab(herdrEnv());
  expect(closes().map((c) => c.params.pane_id)).toEqual([PANE]);
});

test('herdr branch never reaches tmux or osascript', async () => {
  fake = await startFakeHerdr({ panes: [{ pane_id: PANE, tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  const log = path.join(tmpDir, 'calls.log');
  for (const name of ['tmux', 'osascript']) {
    fs.writeFileSync(path.join(binDir, name), `#!/usr/bin/env bash\necho "${name} $*" >> ${JSON.stringify(log)}\nexit 0\n`);
    fs.chmodSync(path.join(binDir, name), 0o755);
  }
  const r = await runCloseTab(herdrEnv({ PATH: `${binDir}:${process.env.PATH}`, TMUX: '/tmp/x,1,0', TMUX_PANE: '%1' }));
  expect(r.status).toBe(0);
  expect(fs.existsSync(log)).toBe(false);
  expect(closes()).toHaveLength(1);
});

test('without ADVISOR_WORKER_BACKEND the herdr branch is skipped', async () => {
  fake = await startFakeHerdr({ panes: [{ pane_id: PANE, tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'tmux'), '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'tmux'), 0o755);
  const env = herdrEnv({ PATH: `${binDir}:${process.env.PATH}`, ADVISOR_TMUX: '1' });
  delete env.ADVISOR_WORKER_BACKEND;
  const r = await runCloseTab(env);
  expect(r.status).toBe(0);
  expect(fake.calls).toHaveLength(0);
});

test('missing HERDR_PANE_ID or HERDR_ENV skips the herdr branch', async () => {
  fake = await startFakeHerdr({ panes: [{ pane_id: PANE, tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
  for (const drop of ['HERDR_PANE_ID', 'HERDR_ENV']) {
    const env = herdrEnv({ ADVISOR_TMUX: '1', PATH: `${path.join(tmpDir, 'nobin')}:${process.env.PATH}` });
    delete env[drop];
    await runCloseTab(env);
  }
  expect(fake.calls).toHaveLength(0);
});

test('unreachable socket still exits 0 and sends nothing', async () => {
  fake = await startFakeHerdr({ panes: [] });
  const r = await runCloseTab(herdrEnv({ HERDR_SOCKET_PATH: path.join(tmpDir, 'nope.sock') }));
  expect(r.status).toBe(0);
  expect(fake.calls).toHaveLength(0);
});
