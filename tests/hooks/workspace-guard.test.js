import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const HOOK_JS = path.join(ADVISOR_ROOT, '.claude', 'hooks', 'workspace-guard.js');

let tmpDir;
let fakeRunsRoot;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-guard-test-'));
  // Create a fake runs root with a session workspace subdir
  fakeRunsRoot = path.join(tmpDir, 'runs');
  fs.mkdirSync(path.join(fakeRunsRoot, 'sess-abc123', 'workspace'), { recursive: true });
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// WG1: workspace-guard.js
// ────────────────────────────────────────────────────────────────────────────

test('WG1: Edit targeting workspace path is blocked with refusal on stdout (WG-1.1)', () => {
  const targetPath = path.join(fakeRunsRoot, 'sess-abc123', 'workspace', 'foo.js');
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: targetPath }
  });

  const result = spawnSync('node', [HOOK_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: fakeRunsRoot }
  });

  // Must block with documented PreToolUse blocking exit code (2)
  expect(result.status).toBe(2);
  // Refusal message must be on stdout (not stderr)
  expect(result.stdout).toBeTruthy();
  expect(result.stdout.trim().length).toBeGreaterThan(0);
});

test('WG1: Write targeting workspace path is blocked with refusal on stdout (WG-1.2)', () => {
  const targetPath = path.join(fakeRunsRoot, 'sess-abc123', 'workspace', 'deep', 'nested', 'file.txt');
  const input = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: targetPath }
  });

  const result = spawnSync('node', [HOOK_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: fakeRunsRoot }
  });

  expect(result.status).toBe(2);
  expect(result.stdout.trim().length).toBeGreaterThan(0);
});

test('WG1: file_path outside workspace prefix exits 0 silently (WG-1.3)', () => {
  const targetPath = path.join(fakeRunsRoot, 'sess-abc123', 'output', 'changes.md');
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: targetPath }
  });

  const result = spawnSync('node', [HOOK_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: fakeRunsRoot }
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

test('WG1: tool_name not Edit or Write exits 0 silently (WG-1.4)', () => {
  const targetPath = path.join(fakeRunsRoot, 'sess-abc123', 'workspace', 'foo.js');
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: `cat "${targetPath}"` }
  });

  const result = spawnSync('node', [HOOK_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: fakeRunsRoot }
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

test('WG1: Read tool targeting workspace path exits 0 silently (WG-1.5)', () => {
  const targetPath = path.join(fakeRunsRoot, 'sess-abc123', 'workspace', 'foo.js');
  const input = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: targetPath }
  });

  const result = spawnSync('node', [HOOK_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: fakeRunsRoot }
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

test('WG1: default ADVISOR_RUNS_ROOT used when env not set (WG-1.6)', () => {
  // A path that does NOT match the default ~/.advisor/runs/*/*/workspace/ pattern
  const innocuousPath = '/tmp/some-other-file.txt';
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: innocuousPath }
  });

  const env = { ...process.env };
  delete env.ADVISOR_RUNS_ROOT;

  const result = spawnSync('node', [HOOK_JS], {
    input,
    encoding: 'utf8',
    env
  });

  expect(result.status).toBe(0);
});
