const { test, expect, beforeEach, afterEach, describe } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  getOrCreateWorktree,
  filesChanged,
  isTerminalStatus,
  removeWorktreeIfTerminal,
} = require('../lib/loop-worktree');

// All fixtures live under a per-test tmpdir; nothing here ever touches the
// real advisor repo's worktrees.
let sandboxRoot;
let repoRoot;
let headSha;

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
}

beforeEach(() => {
  sandboxRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'loop-worktree-test-'));
  repoRoot = path.join(sandboxRoot, 'repo');
  fs.mkdirSync(repoRoot);
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoRoot, 'README.txt'), 'original\n');
  git(repoRoot, ['add', 'README.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  headSha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
});

afterEach(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe('getOrCreateWorktree', () => {
  test('reuse returns the identical path twice and does not reset the working tree', () => {
    const wtPath = path.join(sandboxRoot, 'wt-round');
    const first = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r1' });
    expect(first.created).toBe(true);
    expect(first.path).toBe(wtPath);

    fs.writeFileSync(path.join(wtPath, 'round-progress.txt'), 'round 0 work\n');

    const second = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r1' });
    expect(second.created).toBe(false);
    expect(second.path).toBe(wtPath);
    expect(fs.readFileSync(path.join(wtPath, 'round-progress.txt'), 'utf8')).toBe('round 0 work\n');

    const third = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r1' });
    expect(third.created).toBe(false);
    expect(third.path).toBe(wtPath);
    expect(fs.readFileSync(path.join(wtPath, 'round-progress.txt'), 'utf8')).toBe('round 0 work\n');
  });

  test('a file written in round N is still present in round N+1', () => {
    const wtPath = path.join(sandboxRoot, 'wt-resume');
    const round0 = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r2' });

    fs.writeFileSync(path.join(round0.path, 'round-N.txt'), 'from round N\n');

    const round1 = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r2' });
    expect(round1.path).toBe(round0.path);
    expect(fs.existsSync(path.join(round1.path, 'round-N.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(round1.path, 'round-N.txt'), 'utf8')).toBe('from round N\n');
  });
});

describe('filesChanged', () => {
  test('lists a modified file and an added file', () => {
    const wtPath = path.join(sandboxRoot, 'wt-diff');
    const wt = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r3' });

    fs.writeFileSync(path.join(wt.path, 'README.txt'), 'changed\n');
    fs.writeFileSync(path.join(wt.path, 'new-file.txt'), 'brand new\n');

    const changed = filesChanged(wt.path, headSha);
    expect(changed).toContain('README.txt');
    expect(changed).toContain('new-file.txt');
    expect(changed.length).toBe(2);
  });
});

describe('removeWorktreeIfTerminal', () => {
  test('non-terminal status does not delete; terminal status does', () => {
    const wtPath = path.join(sandboxRoot, 'wt-lifecycle');
    const wt = getOrCreateWorktree(repoRoot, { worktreePath: wtPath, headSha, runId: 'r4' });

    expect(isTerminalStatus('hit-timeout')).toBe(false);
    const removedNonTerminal = removeWorktreeIfTerminal(repoRoot, wt.path, 'hit-timeout');
    expect(removedNonTerminal).toBe(false);
    expect(fs.existsSync(wt.path)).toBe(true);

    expect(isTerminalStatus('won')).toBe(true);
    const removedTerminal = removeWorktreeIfTerminal(repoRoot, wt.path, 'won');
    expect(removedTerminal).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
  });
});
