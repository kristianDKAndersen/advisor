// bin/close-worker-tab herdr branch: runs the REAL script against the fake herdr
// socket server. No herdr binary and no real socket; all HERDR_* env is scrubbed.
import { test, expect } from 'bun:test';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { startFakeHerdr } from './fixtures/herdr-fake-server.js';

const ROOT = path.resolve(import.meta.dir, '..');
const CLOSE_WORKER_TAB = path.join(ROOT, 'bin', 'close-worker-tab');
const ADVISOR_TERMINATE = path.join(ROOT, 'bin', 'advisor-terminate');

function setup(sid) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-herdr-'));
  const runDir = path.join(home, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });
  // A tmux stub on PATH records any invocation so tests can prove tmux was not used.
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const tmuxLog = path.join(home, 'tmux-calls.log');
  fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh\necho "$@" >> "${tmuxLog}"\nexit 1\n`, { mode: 0o755 });
  return { home, runDir, binDir, tmuxLog };
}

function scrubbedEnv(s, extra = {}) {
  const env = { ...process.env, HOME: s.home, PATH: `${s.binDir}:${process.env.PATH}`, ADVISOR_SKIP_WORKTREE_CLEANUP: '1', ...extra };
  for (const k of ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_ENV', 'ADVISOR_HERDR', 'ADVISOR_WORKER_BACKEND', 'ADVISOR_TMUX_MULTIPLEX']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

// Async: the fake server shares this event loop, so spawnSync would deadlock it.
const run = (cmd, args, env) => new Promise((resolve) => {
  const c = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  c.stderr.on('data', (d) => { stderr += d; });
  c.stdout.resume();
  const t = setTimeout(() => c.kill('SIGKILL'), 25000);
  c.on('close', (status) => { clearTimeout(t); resolve({ status, stderr }); });
});
const closes = (fake) => fake.calls.filter((c) => c.method === 'pane.close').map((c) => c.params.pane_id);
const tmuxCalled = (s) => fs.existsSync(s.tmuxLog);

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

async function withFake(sid, panes, fn) {
  const fake = await startFakeHerdr({ panes, tabs: [{ tab_id: 'w1:t1', label: 'advisor' }] });
  const s = setup(sid);
  try { await fn(fake, s); } finally {
    await fake.stop();
    fs.rmSync(s.home, { recursive: true, force: true });
  }
}

test('herdr runner.json: closes only the token-matching pane, SIGTERMs the runner, socket from runner.json, no tmux', async () => {
  const sid = `cwt-h-main-${Date.now()}`;
  await withFake(sid, [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: sid } },
    { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'someone-else' } },
    { pane_id: 'w1:p3', tab_id: 'w1:t1' },
  ], async (fake, s) => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 100000)', 'herdr-runner.js', '--sid', sid], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(s.runDir, 'runner.json'), JSON.stringify({
        pid: child.pid, mode: 'herdr', backend: 'herdr', pane_id: 'w1:p1', socket_path: fake.socketPath, started_at: Date.now(),
      }));
      const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s));
      expect(r.status).toBe(0);
      expect(closes(fake)).toEqual(['w1:p1']);
      expect(await waitExit(child, 3000)).toBe(true);
      expect(tmuxCalled(s)).toBe(false);
    } finally { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} }
  });
});

test('herdr runner.json: env HERDR_SOCKET_PATH is used when set', async () => {
  const sid = `cwt-h-env-${Date.now()}`;
  await withFake(sid, [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: sid } }], async (fake, s) => {
    fs.writeFileSync(path.join(s.runDir, 'runner.json'), JSON.stringify({
      pid: 999999, backend: 'herdr', pane_id: 'w1:p1', socket_path: '/nonexistent/h.sock',
    }));
    const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s, { HERDR_SOCKET_PATH: fake.socketPath }));
    expect(r.status).toBe(0);
    expect(closes(fake)).toEqual(['w1:p1']);
  });
});

test('runner.json gone + ADVISOR_HERDR=1 HERDR_ENV=1: closes by token scan, foreign pane untouched', async () => {
  const sid = `cwt-h-scan-${Date.now()}`;
  await withFake(sid, [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: sid } },
    { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'other' } },
  ], async (fake, s) => {
    const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s, { ADVISOR_HERDR: '1', HERDR_ENV: '1', HERDR_SOCKET_PATH: fake.socketPath }));
    expect(r.status).toBe(0);
    expect(closes(fake)).toEqual(['w1:p1']);
    expect(tmuxCalled(s)).toBe(false);
  });
});

test('runner.json gone + flags unset: herdr is not contacted, tmux path runs', async () => {
  const sid = `cwt-h-off-${Date.now()}`;
  await withFake(sid, [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: sid } }], async (fake, s) => {
    const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s, { HERDR_SOCKET_PATH: fake.socketPath }));
    expect(r.status).toBe(0);
    expect(fake.calls.length).toBe(0);
    expect(tmuxCalled(s)).toBe(true);
  });
});

test('runner.json backend=tmux wins over herdr env flags', async () => {
  const sid = `cwt-h-tmux-${Date.now()}`;
  await withFake(sid, [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: sid } }], async (fake, s) => {
    fs.writeFileSync(path.join(s.runDir, 'runner.json'), JSON.stringify({ pid: 999999, mode: 'multiplex', pane_id: '%9' }));
    const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s, { ADVISOR_HERDR: '1', HERDR_ENV: '1', HERDR_SOCKET_PATH: fake.socketPath }));
    expect(r.status).toBe(0);
    expect(fake.calls.length).toBe(0);
    expect(tmuxCalled(s)).toBe(true);
  });
});

test('herdr socket down: exits 0 without crashing', async () => {
  const sid = `cwt-h-down-${Date.now()}`;
  const s = setup(sid);
  try {
    fs.writeFileSync(path.join(s.runDir, 'runner.json'), JSON.stringify({
      pid: 999999, backend: 'herdr', pane_id: 'w1:p1', socket_path: path.join(s.home, 'dead.sock'),
    }));
    const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s));
    expect(r.status).toBe(0);
    expect(tmuxCalled(s)).toBe(false);
  } finally { fs.rmSync(s.home, { recursive: true, force: true }); }
});

test('herdr mode still reaches worktree cleanup (no tty.txt needed)', async () => {
  const sid = `cwt-h-wt-${Date.now()}`;
  await withFake(sid, [], async (fake, s) => {
    fs.mkdirSync(path.join(s.runDir, 'workspace'));
    fs.writeFileSync(path.join(s.runDir, 'runner.json'), JSON.stringify({ pid: 999999, backend: 'herdr', socket_path: fake.socketPath }));
    const r = await run(CLOSE_WORKER_TAB, [sid], scrubbedEnv(s, { ADVISOR_SKIP_WORKTREE_CLEANUP: '' }));
    expect(r.status).toBe(0);
    const trace = fs.readFileSync(path.join(s.home, '.advisor', 'state', 'tab-close-trace.log'), 'utf8');
    expect(trace).toContain('action=worktree-remove');
  });
});

test('advisor-terminate reaches the herdr branch', async () => {
  const sid = `cwt-h-term-${Date.now()}`;
  await withFake(sid, [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: sid } },
    { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'other' } },
  ], async (fake, s) => {
    fs.mkdirSync(path.join(s.runDir, 'channel'));
    fs.writeFileSync(path.join(s.runDir, 'runner.json'), JSON.stringify({ pid: 999999, backend: 'herdr', pane_id: 'w1:p1', socket_path: fake.socketPath }));
    const r = await run(ADVISOR_TERMINATE, [sid], scrubbedEnv(s));
    expect(r.status).toBe(0);
    expect(closes(fake)).toEqual(['w1:p1']);
    expect(fs.readFileSync(path.join(s.runDir, 'channel', 'inbox.jsonl'), 'utf8')).toContain('terminate');
  });
});
