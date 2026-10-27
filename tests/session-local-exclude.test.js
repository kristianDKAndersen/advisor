import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import session from '../lib/session.js';

const LINE = '.advisor-output/';
const dirs = [];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-exclude-')));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', 'README');
  git(dir, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.advisor-output', 'sid'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.advisor-output', 'sid', 'out.md'), 'o\n');
  return dir;
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    return { ret: fn(), out };
  } finally {
    process.stderr.write = orig;
  }
}

function countLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() === LINE).length;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('adds the line to info/exclude, creates no .gitignore, status stays clean', () => {
  const repo = makeRepo();
  expect(session.ensureLocalExclude(repo)).toBe(true);
  expect(countLines(path.join(repo, '.git', 'info', 'exclude'))).toBe(1);
  expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

test('second call returns false and leaves a single line', () => {
  const repo = makeRepo();
  session.ensureLocalExclude(repo);
  expect(session.ensureLocalExclude(repo)).toBe(false);
  expect(countLines(path.join(repo, '.git', 'info', 'exclude'))).toBe(1);
});

test('creates info/ when missing', () => {
  const repo = makeRepo();
  fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
  expect(session.ensureLocalExclude(repo)).toBe(true);
  expect(countLines(path.join(repo, '.git', 'info', 'exclude'))).toBe(1);
});

test('inside a linked worktree it writes the common dir info/exclude', () => {
  const repo = makeRepo();
  const wt = path.join(repo, '..', path.basename(repo) + '-wt');
  dirs.push(wt);
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  fs.mkdirSync(path.join(wt, '.advisor-output'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.advisor-output', 'o.md'), 'o\n');
  expect(session.localExcludePath(wt)).toBe(path.join(repo, '.git', 'info', 'exclude'));
  expect(session.ensureLocalExclude(wt)).toBe(true);
  expect(countLines(path.join(repo, '.git', 'info', 'exclude'))).toBe(1);
  expect(fs.existsSync(path.join(wt, '.gitignore'))).toBe(false);
  expect(git(wt, 'status', '--porcelain')).toBe('');
});

test('C9: exclude already holds the line - status empty, exclude byte-identical', () => {
  const repo = makeRepo();
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  fs.appendFileSync(exclude, `${LINE}\n`);
  const before = fs.readFileSync(exclude);
  expect(session.ensureLocalExclude(repo)).toBe(false);
  expect(fs.readFileSync(exclude).equals(before)).toBe(true);
  expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

test('old uncommitted .gitignore line: notice printed, file byte-identical', () => {
  const repo = makeRepo();
  const gi = path.join(repo, '.gitignore');
  fs.writeFileSync(gi, 'node_modules/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'gi');
  fs.appendFileSync(gi, `${LINE}\n`);
  const before = fs.readFileSync(gi);
  const { out } = captureStderr(() => session.ensureLocalExclude(repo));
  expect(out).toContain('no longer needed');
  expect(out).toContain(`git -C ${repo} checkout -- .gitignore`);
  expect(out.trim().split('\n').length).toBe(1);
  expect(fs.readFileSync(gi).equals(before)).toBe(true);
});

test('no notice when .gitignore diff is not exactly the old line', () => {
  const repo = makeRepo();
  const gi = path.join(repo, '.gitignore');
  fs.writeFileSync(gi, 'node_modules/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'gi');
  fs.appendFileSync(gi, `${LINE}\ndist/\n`);
  const { out } = captureStderr(() => session.ensureLocalExclude(repo));
  expect(out).toBe('');
});
