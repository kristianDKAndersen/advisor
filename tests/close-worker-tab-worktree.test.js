// Tests that bin/close-worker-tab removes the per-worker git worktree
// (and its ws/<sid> branch) once the worker has terminated.
//
// Coder workers are provisioned as git worktrees on a ws/<sid> branch in
// lib/summon.js; without this cleanup, every worker permanently leaves a
// worktree dir under ~/.advisor/runs/<sid>/workspace/ and a ws/<sid> ref
// in .git, which accumulated to 322 worktrees + 433 branches before the
// 2026-05-28 bulk sweep. This test pins the cleanup contract.

// NB: each test is given a 30s budget — git worktree add/remove against a
// macOS /var/folders tmpdir routinely takes 2-4s, so the default 5s budget
// trips the no-op test mid-setup.
import { test, expect, beforeEach, afterEach } from 'bun:test';
const TEST_TIMEOUT = 30000;
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const CLOSE_WORKER_TAB = path.join(ADVISOR_ROOT, 'bin', 'close-worker-tab');

let tmpHome;
let sid;
let workspaceDir;
let branchName;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-worktree-'));
  sid = `test-cwt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  branchName = `ws/${sid}`;
  const runDir = path.join(tmpHome, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });
  workspaceDir = path.join(runDir, 'workspace');

  // Provision a real git worktree off master so close-worker-tab has
  // something to clean up.
  execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'add', '-b', branchName, workspaceDir, 'master'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // close-worker-tab's Apple-Terminal path needs a tty.txt; leave one with a
  // bogus tty so the osascript branch is a no-op on the test runner.
  fs.writeFileSync(path.join(runDir, 'tty.txt'), '/dev/null\n');
});

afterEach(() => {
  // Hard belt-and-suspenders cleanup so a failing test cannot leak a worktree
  // or a ws/<sid> branch into the real repo.
  try { execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'remove', '--force', workspaceDir], { stdio: 'ignore' }); } catch (_) {}
  try { execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'prune'], { stdio: 'ignore' }); } catch (_) {}
  try { execFileSync('git', ['-C', ADVISOR_ROOT, 'branch', '-D', branchName], { stdio: 'ignore' }); } catch (_) {}
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

function listBranches() {
  return execFileSync('git', ['-C', ADVISOR_ROOT, 'branch', '--list', branchName], { encoding: 'utf8' }).trim();
}

function listWorktrees() {
  return execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
}

test('close-worker-tab removes the worker worktree and its ws/<sid> branch', { timeout: TEST_TIMEOUT }, () => {
  // Pre-conditions: worktree present, branch present.
  expect(fs.existsSync(workspaceDir)).toBe(true);
  expect(listBranches()).toContain(branchName);
  expect(listWorktrees()).toContain(workspaceDir);

  const result = spawnSync(CLOSE_WORKER_TAB, [sid], {
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf8'
  });
  expect(result.status).toBe(0);

  // Post-conditions: worktree dir gone, worktree dereg'd, branch deleted.
  expect(fs.existsSync(workspaceDir)).toBe(false);
  expect(listWorktrees()).not.toContain(workspaceDir);
  expect(listBranches()).toBe('');
});

test('close-worker-tab skips worktree cleanup when ADVISOR_SKIP_WORKTREE_CLEANUP=1', { timeout: TEST_TIMEOUT }, () => {
  const result = spawnSync(CLOSE_WORKER_TAB, [sid], {
    env: { ...process.env, HOME: tmpHome, ADVISOR_SKIP_WORKTREE_CLEANUP: '1' },
    encoding: 'utf8'
  });
  expect(result.status).toBe(0);

  // Worktree and branch should still exist.
  expect(fs.existsSync(workspaceDir)).toBe(true);
  expect(listBranches()).toContain(branchName);
});

test('[N5] close-worker-tab warns on stderr when branch delete fails', { timeout: TEST_TIMEOUT }, () => {
  // Pre-conditions: worktree present, branch present.
  expect(fs.existsSync(workspaceDir)).toBe(true);
  expect(listBranches()).toContain(branchName);

  // Delete the branch ref directly (bypasses "checked out in worktree" guard)
  // so git worktree remove --force succeeds but git branch -D fails with "not found".
  execFileSync('git', ['-C', ADVISOR_ROOT, 'update-ref', '-d', `refs/heads/${branchName}`], { stdio: 'ignore' });
  expect(listBranches()).toBe('');

  const result = spawnSync(CLOSE_WORKER_TAB, [sid], {
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf8'
  });

  // Script must not abort (non-aborting behavior preserved).
  expect(result.status).toBe(0);

  // After the fix, stderr should contain a WARN about the failed branch delete.
  expect(result.stderr).toMatch(/WARN/);
});

test('close-worker-tab is a no-op when no worktree is registered for the sid', { timeout: TEST_TIMEOUT }, () => {
  // Pre-emptively clean the worktree so the script has nothing to remove.
  execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'remove', '--force', workspaceDir]);
  execFileSync('git', ['-C', ADVISOR_ROOT, 'branch', '-D', branchName]);

  // Recreate the runDir + tty.txt (close-worker-tab needs the dir to exist
  // for the tmux/Apple-Terminal phases to run; without it, the script exits
  // early before reaching the worktree-cleanup block).
  const runDir = path.join(tmpHome, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'tty.txt'), '/dev/null\n');

  const result = spawnSync(CLOSE_WORKER_TAB, [sid], {
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf8'
  });
  expect(result.status).toBe(0);
});
