import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import { extractSid } from '../../lib/hooks/branch-guard.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const HOOK = path.join(REPO_ROOT, 'lib', 'hooks', 'branch-guard.js');

function runHook(stdinJson, extraEnv = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...extraEnv },
  });
}

function initGitRepo(dir, branch) {
  execFileSync('git', ['init', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init', '--allow-empty']);
  if (branch) {
    execFileSync('git', ['-C', dir, 'checkout', '-b', branch]);
  }
}

// ── BG-0: extractSid unit tests ───────────────────────────────────────────
describe('extractSid', () => {
  test('BG-0.1: extracts sid from standard INBOX path', () => {
    expect(extractSid('/Users/foo/.advisor/runs/abc123/channel/inbox.jsonl')).toBe('abc123');
  });

  test('BG-0.2: extracts hyphenated sid', () => {
    expect(extractSid('/home/user/.advisor/runs/1781527623-95ecf9/channel/inbox.jsonl'))
      .toBe('1781527623-95ecf9');
  });

  test('BG-0.3: returns null for null/undefined/empty INBOX', () => {
    expect(extractSid(null)).toBeNull();
    expect(extractSid(undefined)).toBeNull();
    expect(extractSid('')).toBeNull();
  });

  test('BG-0.4: returns null when path does not match /runs/<sid>/channel pattern', () => {
    expect(extractSid('/some/other/path/inbox.jsonl')).toBeNull();
  });
});

// ── BG-CLI: process-level integration tests ───────────────────────────────
describe('branch-guard hook — CLI', () => {
  let tmpDir;
  let correctBranchDir;
  let wrongBranchDir;
  let noGitDir;
  let detachedDir;
  const SID = 'test-sid-abc999';
  const INBOX_PATH = `/Users/user/.advisor/runs/${SID}/channel/inbox.jsonl`;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-guard-test-'));

    correctBranchDir = path.join(tmpDir, 'correct-branch');
    fs.mkdirSync(correctBranchDir, { recursive: true });
    initGitRepo(correctBranchDir, `ws/${SID}`);

    wrongBranchDir = path.join(tmpDir, 'wrong-branch');
    fs.mkdirSync(wrongBranchDir, { recursive: true });
    initGitRepo(wrongBranchDir, null); // stays on main/master

    noGitDir = path.join(tmpDir, 'no-git');
    fs.mkdirSync(noGitDir, { recursive: true });

    detachedDir = path.join(tmpDir, 'detached');
    fs.mkdirSync(detachedDir, { recursive: true });
    initGitRepo(detachedDir, null);
    execFileSync('git', ['-C', detachedDir, 'checkout', '--detach', 'HEAD']);
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('BG-1: non-Edit/Write tool name exits 0 silently', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: correctBranchDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('BG-2: absent INBOX fails-open (exit 0)', () => {
    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } },
      { CLAUDE_PROJECT_DIR: correctBranchDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('BG-3: INBOX without sid pattern fails-open (exit 0)', () => {
    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } },
      { INBOX: '/some/other/path/inbox.jsonl', CLAUDE_PROJECT_DIR: correctBranchDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('BG-4: non-git directory fails-open when git throws (exit 0)', () => {
    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } },
      { INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: noGitDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('BG-5: correct branch ws/<sid> allows (exit 0, empty stdout)', () => {
    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } },
      { INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: correctBranchDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('BG-6: wrong branch blocks with exit 2 and message on stdout', () => {
    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } },
      { INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: wrongBranchDir }
    );
    expect(r.status).toBe(2);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toContain('branch-guard');
    expect(r.stdout).toContain(`ws/${SID}`);
    expect(r.stderr).toBe('');
  });

  test('BG-7: Write tool also blocked on wrong branch (exit 2)', () => {
    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/some/file.js' } },
      { INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: wrongBranchDir }
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('branch-guard');
  });

  test('BG-8: detached HEAD fails-open (exit 0)', () => {
    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } },
      { INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: detachedDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('BG-9: malformed JSON input fails-open (exit 0)', () => {
    const r = spawnSync('node', [HOOK], {
      input: 'not valid json',
      encoding: 'utf8',
      env: { PATH: process.env.PATH, INBOX: INBOX_PATH, CLAUDE_PROJECT_DIR: correctBranchDir },
    });
    expect(r.status).toBe(0);
  });

  test('BG-10: CLAUDE_PROJECT_DIR absent falls back to cwd (non-git cwd -> fail-open)', () => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/some/file.js' } }),
      encoding: 'utf8',
      cwd: noGitDir,
      env: { PATH: process.env.PATH, INBOX: INBOX_PATH },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
