// Tests for synthesize worktree/workspace cleanup (forward-looking leak prevention).
// Exercises the fail-open cleanup block added to channel.js synthesize.
//
// Runs synthesize as a subprocess (like doc-enqueue.test.js) so ADVISOR_RUNS_ROOT
// is picked up at session.js module-load time in the child process.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;

let tmpRuns;
let tmpRepo;
let sid;
let workspaceDir;
let branchName;

beforeEach(() => {
  sid = `test-sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  branchName = `ws/${sid}`;

  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-cleanup-'));

  // Bare git repo that will own the worktree — mirrors meta.repo in production.
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-repo-'));
  execFileSync('git', ['init'], { cwd: tmpRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpRepo, 'base.txt'), 'base');
  execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, stdio: 'ignore' });

  workspaceDir = path.join(tmpRuns, sid, 'workspace');
});

afterEach(() => {
  // Best-effort cleanup in case the test failed mid-way and left the worktree.
  try { execFileSync('git', ['-C', tmpRepo, 'worktree', 'remove', '--force', workspaceDir], { stdio: 'ignore' }); } catch (_) {}
  try { execFileSync('git', ['-C', tmpRepo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch (_) {}
  try { execFileSync('git', ['-C', tmpRepo, 'branch', '-D', branchName], { stdio: 'ignore' }); } catch (_) {}
  if (tmpRuns) fs.rmSync(tmpRuns, { recursive: true, force: true });
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function writeMeta(meta) {
  const runDir = path.join(tmpRuns, sid);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta));
}

function runSynthesize(extraEnv = {}) {
  return spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize',
      '--sid', sid,
      '--seq', '1',
      '--established', 'test task',
      '--gap', 'none',
      '--material', 'yes',
      '--next', 'proceed'],
    {
      encoding: 'utf8',
      timeout: 25000,
      env: {
        ...process.env,
        ADVISOR_RUNS_ROOT: tmpRuns,
        ADVISOR_SKIP_TAB_CLOSE: '1',
        ...extraEnv,
      },
    }
  );
}

// ── SC1: coder worktree removed and branch deleted ────────────────────────────
test('[SC1] coder worktree is removed and branch deleted after synthesize', { timeout: TEST_TIMEOUT }, () => {
  // Provision a real git worktree on branch ws/<sid> at the workspace path.
  execFileSync('git', ['-C', tmpRepo, 'worktree', 'add', '-b', branchName, workspaceDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  writeMeta({ agent: 'coder', repo: tmpRepo });

  const result = runSynthesize();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');

  // Workspace directory must be gone.
  expect(fs.existsSync(workspaceDir)).toBe(false);

  // Branch must be deleted.
  const branchList = execFileSync('git', ['-C', tmpRepo, 'branch', '--list', branchName], { encoding: 'utf8' }).trim();
  expect(branchList).toBe('');

  // git worktree list must not show this sid any more.
  const wtList = execFileSync('git', ['-C', tmpRepo, 'worktree', 'list'], { encoding: 'utf8' });
  expect(wtList).not.toContain(sid);
});

// ── SC2: absent worktree is a no-op and synthesize still succeeds ─────────────
test('[SC2] absent worktree path does not throw and synthesize succeeds (fail-open)', { timeout: TEST_TIMEOUT }, () => {
  // workspaceDir does NOT exist — guard should short-circuit silently.
  writeMeta({ agent: 'coder', repo: tmpRepo });

  const result = runSynthesize();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');
});
