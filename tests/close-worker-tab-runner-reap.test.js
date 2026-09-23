// Tests that bin/close-worker-tab reaps the tmux-runner.js process named in
// runs/<sid>/runner.json directly, and refuses to kill a pid whose argv does
// not match `tmux-runner.js --sid <sid>` (protects against a reused pid).
//
// SAFETY: uses fabricated sids and a dummy `node -e` child process standing in
// for the real runner — never spawns bin/summon or a real worker.
import { test, expect } from 'bun:test';
import { spawn, spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const CLOSE_WORKER_TAB = path.join(ADVISOR_ROOT, 'bin', 'close-worker-tab');

function setupRunDir(sid) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-reap-'));
  const runDir = path.join(tmpHome, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'tty.txt'), '/dev/null\n');
  return { tmpHome, runDir };
}

// process.kill(pid, 0) succeeds on a zombie (defunct, already-terminated but
// not yet reaped) child too, so it cannot tell "killed" from "still running".
// Track real termination via the child's own 'exit' event instead.
function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

test('close-worker-tab SIGTERMs a runner.json pid whose argv matches tmux-runner.js --sid <sid>', async () => {
  const sid = `reap-match-${Date.now()}`;
  const { tmpHome, runDir } = setupRunDir(sid);

  const child = spawn('node', ['-e', 'setInterval(() => {}, 100000)', 'tmux-runner.js', '--sid', sid], { stdio: 'ignore' });

  try {
    fs.writeFileSync(path.join(runDir, 'runner.json'), JSON.stringify({
      pid: child.pid, mode: 'multiplex', pane_id: '%999', started_at: Date.now(),
    }));
    expect(child.exitCode).toBeNull();

    const result = spawnSync(CLOSE_WORKER_TAB, [sid], {
      env: { ...process.env, HOME: tmpHome, ADVISOR_SKIP_WORKTREE_CLEANUP: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    const exited = await waitExit(child, 3000);
    expect(exited).toBe(true);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('close-worker-tab refuses to kill a runner.json pid whose argv does not match the sid', async () => {
  const sid = `reap-nomatch-${Date.now()}`;
  const { tmpHome, runDir } = setupRunDir(sid);

  const child = spawn('node', ['-e', 'setInterval(() => {}, 100000)', 'unrelated-process'], { stdio: 'ignore' });

  try {
    fs.writeFileSync(path.join(runDir, 'runner.json'), JSON.stringify({
      pid: child.pid, mode: 'multiplex', pane_id: '%998', started_at: Date.now(),
    }));
    expect(child.exitCode).toBeNull();

    const result = spawnSync(CLOSE_WORKER_TAB, [sid], {
      env: { ...process.env, HOME: tmpHome, ADVISOR_SKIP_WORKTREE_CLEANUP: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    const exited = await waitExit(child, 500);
    expect(exited).toBe(false); // must NOT have been signaled
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
