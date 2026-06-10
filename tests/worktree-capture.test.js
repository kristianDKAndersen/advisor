// Approach A (capture-before-remove) durability + regression tests.
//
// Proves coder worktree output survives teardown: bin/close-worker-tab must
// snapshot the worktree's changed + untracked file set into $OUTPUT_DIR
// (via bin/_worktree-capture.sh::_capture_worktree) BEFORE force-removing the
// worktree, fail-closed if capture fails. Plan §4 cases D1-D4 + R6-R8.
//
// Each test builds a single ephemeral worktree off the real repo's master in a
// tmpHome and force-cleans it in afterEach (same sanctioned pattern as
// tests/close-worker-tab-worktree.test.js). It never sweeps or touches the
// other registered worktrees.

import { test, expect, beforeEach, afterEach } from 'bun:test';
const TEST_TIMEOUT = 30000;
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const CLOSE_WORKER_TAB = path.join(ADVISOR_ROOT, 'bin', 'close-worker-tab');
const CAPTURE_LIB = path.join(ADVISOR_ROOT, 'bin', '_worktree-capture.sh');

let tmpHome;
let sid;
let workspaceDir;
let outputDir;
let branchName;
let isWorktree;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-capture-'));
  sid = `test-wtc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  branchName = `ws/${sid}`;
  const runDir = path.join(tmpHome, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });
  workspaceDir = path.join(runDir, 'workspace');
  outputDir = path.join(runDir, 'output');
  isWorktree = false;
  fs.writeFileSync(path.join(runDir, 'tty.txt'), '/dev/null\n');
});

function provisionWorktree() {
  execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'add', '-b', branchName, workspaceDir, 'master'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  isWorktree = true;
}

afterEach(() => {
  if (isWorktree) {
    try { fs.chmodSync(path.join(outputDir, 'worktree-capture', 'files'), 0o755); } catch (_) {}
    try { execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'remove', '--force', workspaceDir], { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('git', ['-C', ADVISOR_ROOT, 'worktree', 'prune'], { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('git', ['-C', ADVISOR_ROOT, 'branch', '-D', branchName], { stdio: 'ignore' }); } catch (_) {}
  }
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Invoke the sourced library function _capture_worktree directly (not via the
// full close-worker-tab driver) so the test pins capture's own exit code.
function runCapture() {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; _capture_worktree "$2" "$3" "$4"', 'bash', CAPTURE_LIB, workspaceDir, outputDir, sid],
    { encoding: 'utf8' },
  );
}

function runClose(extraEnv = {}) {
  return spawnSync(CLOSE_WORKER_TAB, [sid], {
    env: { ...process.env, HOME: tmpHome, ...extraEnv },
    encoding: 'utf8',
  });
}

function listBranches() {
  return execFileSync('git', ['-C', ADVISOR_ROOT, 'branch', '--list', branchName], { encoding: 'utf8' }).trim();
}

// ── Harness gate: the bunfig preload must default ADVISOR_NO_REAPER on, so a
// bare `bun test` (importing lib/tmux-runner.js) never auto-sweeps the real
// repo's ws/* worktrees. This file imports no reaper, so the probe is itself
// safe; run it with the env unset to prove the preload key is wired. ──────────
test('[harness] tests/setup-no-reaper.js preload defaults ADVISOR_NO_REAPER=1', () => {
  expect(process.env.ADVISOR_NO_REAPER).toBe('1');
});

// ── D1: untracked file survives teardown ─────────────────────────────────────
test('[D1] untracked coder file survives teardown via worktree-capture/files', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();
  const payload = 'coder result line 1\ncoder result line 2\n';
  fs.writeFileSync(path.join(workspaceDir, 'result.txt'), payload);

  const result = runClose();
  expect(result.status).toBe(0);

  const captured = path.join(outputDir, 'worktree-capture', 'files', 'result.txt');
  expect(fs.existsSync(captured)).toBe(true);
  expect(fs.readFileSync(captured, 'utf8')).toBe(payload);
  // worktree itself is gone (removal proceeded after a successful capture).
  expect(fs.existsSync(workspaceDir)).toBe(false);
});

// ── D2: tracked-but-uncommitted modification survives via worktree.patch ──────
test('[D2] tracked uncommitted modification is recoverable from worktree.patch', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();
  const marker = `WTC-MARKER-${sid}`;
  const tracked = path.join(workspaceDir, 'package.json');
  fs.appendFileSync(tracked, `\n// ${marker}\n`);

  const result = runClose();
  expect(result.status).toBe(0);

  const patchPath = path.join(outputDir, 'worktree-capture', 'worktree.patch');
  expect(fs.existsSync(patchPath)).toBe(true);
  const patch = fs.readFileSync(patchPath, 'utf8');
  expect(patch).toContain('package.json');
  expect(patch).toContain(marker);
});

// ── D3: binary file round-trips byte-identical ───────────────────────────────
test('[D3] binary untracked file round-trips byte-identical', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80]);
  fs.writeFileSync(path.join(workspaceDir, 'blob.bin'), bytes);

  const result = runClose();
  expect(result.status).toBe(0);

  const captured = path.join(outputDir, 'worktree-capture', 'files', 'blob.bin');
  expect(fs.existsSync(captured)).toBe(true);
  expect(fs.readFileSync(captured).equals(bytes)).toBe(true);
});

// ── D4: fail-closed — capture failure blocks removal; escape hatch overrides ──
test('[D4] capture failure is fail-closed and ADVISOR_FORCE_REMOVE_UNCAPTURED overrides', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();
  fs.writeFileSync(path.join(workspaceDir, 'result.txt'), 'precious\n');

  // Force a capture failure: pre-create the files dir read-only so cp into it fails
  // while the capture dir itself stays writable (so CAPTURE_FAILED can be written).
  const captureDir = path.join(outputDir, 'worktree-capture');
  const filesDir = path.join(captureDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.chmodSync(filesDir, 0o555);

  const blocked = runClose();
  expect(blocked.status).toBe(0); // script must not abort
  // Fail-closed: worktree NOT removed, branch retained, marker written.
  expect(fs.existsSync(workspaceDir)).toBe(true);
  expect(listBranches()).toContain(branchName);
  expect(fs.existsSync(path.join(captureDir, 'CAPTURE_FAILED'))).toBe(true);

  // Escape hatch: removal proceeds despite the still-failing capture.
  const forced = runClose({ ADVISOR_FORCE_REMOVE_UNCAPTURED: '1' });
  expect(forced.status).toBe(0);
  expect(fs.existsSync(workspaceDir)).toBe(false);
});

// ── D5: untracked symlink-to-directory is captured AS a symlink (regression) ──
// Every real coder worktree carries merged skill symlinks under .claude/skills/
// (e.g. .claude/skills/foo -> a directory). The materialize loop must copy such
// an entry verbatim (as a symlink), not follow it. With the old `cp "$src"`
// (no -a) the symlink is dereferenced, cp hits "is a directory", returns
// non-zero → rc=1 → CAPTURE_FAILED on EVERY real worktree. This fixture (an
// untracked symlink pointing at a real dir) IS the bug: without the symlink it
// would falsely pass.
test('[D5] untracked symlink-to-dir is captured as a symlink (rc==0)', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();

  // A real directory OUTSIDE the worktree, so the only untracked entry under
  // .claude/skills/ is the symlink itself (the dir's contents are not captured).
  const realTarget = path.join(tmpHome, 'real-skill-dir');
  fs.mkdirSync(realTarget, { recursive: true });
  fs.writeFileSync(path.join(realTarget, 'SKILL.md'), '# foo skill\n');

  const skillsDir = path.join(workspaceDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.symlinkSync(realTarget, path.join(skillsDir, 'foo'));

  const cap = runCapture();
  // Capture must succeed: a symlink-to-dir is normal worktree content, not a failure.
  expect(cap.status).toBe(0);

  const captured = path.join(outputDir, 'worktree-capture', 'files', '.claude', 'skills', 'foo');
  expect(fs.existsSync(captured)).toBe(true);
  // It must itself be a symlink, NOT a recursively-copied directory tree.
  expect(fs.lstatSync(captured).isSymbolicLink()).toBe(true);
  // No CAPTURE_FAILED marker was written.
  expect(fs.existsSync(path.join(outputDir, 'worktree-capture', 'CAPTURE_FAILED'))).toBe(false);
});

// ── R6: isolation/happy path — clean worktree captured then removed ───────────
test('[R6] clean worktree is captured (MANIFEST) and then removed + branch deleted', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();

  const result = runClose();
  expect(result.status).toBe(0);

  // Capture ran (manifest present) and removal completed.
  expect(fs.existsSync(path.join(outputDir, 'worktree-capture', 'MANIFEST.json'))).toBe(true);
  expect(fs.existsSync(workspaceDir)).toBe(false);
  expect(listBranches()).toBe('');
});

// ── R7: copyDir (non-coder) plain dir — graceful skip, no capture, no crash ───
test('[R7] non-worktree workspace dir is a graceful no-op (no worktree-capture, no crash)', { timeout: TEST_TIMEOUT }, () => {
  // Plain directory, NOT a git worktree.
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'note.txt'), 'plain\n');

  const result = runClose();
  expect(result.status).toBe(0);
  // No capture artifacts for a non-worktree dir.
  expect(fs.existsSync(path.join(outputDir, 'worktree-capture'))).toBe(false);
  // Removal of a non-worktree fails silently; dir is left in place.
  expect(fs.existsSync(workspaceDir)).toBe(true);
});

// ── R8: ADVISOR_SKIP_WORKTREE_CLEANUP preserves worktree AND skips capture ────
test('[R8] ADVISOR_SKIP_WORKTREE_CLEANUP=1 retains worktree+branch and skips capture', { timeout: TEST_TIMEOUT }, () => {
  provisionWorktree();
  fs.writeFileSync(path.join(workspaceDir, 'result.txt'), 'keep\n');

  const result = runClose({ ADVISOR_SKIP_WORKTREE_CLEANUP: '1' });
  expect(result.status).toBe(0);

  expect(fs.existsSync(workspaceDir)).toBe(true);
  expect(listBranches()).toContain(branchName);
  // Post-mortem mode keeps everything in place — no capture performed.
  expect(fs.existsSync(path.join(outputDir, 'worktree-capture'))).toBe(false);
});
