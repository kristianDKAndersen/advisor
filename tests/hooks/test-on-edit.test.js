import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const HOOK_PATH = path.join(ADVISOR_ROOT, '.claude', 'hooks', 'test-on-edit.js');

let tmpDir;
let fakeProjectDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-on-edit-'));
  fakeProjectDir = path.join(tmpDir, 'project');

  fs.mkdirSync(path.join(fakeProjectDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fakeProjectDir, 'tests'), { recursive: true });

  fs.writeFileSync(path.join(fakeProjectDir, 'lib', 'foo.js'), 'module.exports = { foo: 1 };\n');

  // Trivial passing bun test
  fs.writeFileSync(
    path.join(fakeProjectDir, 'tests', 'foo.test.js'),
    "import { test, expect } from 'bun:test';\ntest('trivial', () => { expect(1).toBe(1); });\n"
  );
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// AT-5.1: matching lib file with existing test file triggers bun test, stderr has JSON result
test('H5: lib/foo.js edit triggers test run, stderr contains JSON result (AT-5.1)', () => {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fakeProjectDir, 'lib', 'foo.js') },
    tool_response: { output: '' }
  });

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProjectDir }
  });

  expect(result.status).toBe(0);
  const lines = result.stderr.trim().split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  const parsed = JSON.parse(lines[lines.length - 1]);
  expect(parsed).toHaveProperty('test_file', 'tests/foo.test.js');
  expect(parsed).toHaveProperty('exit_code');
  expect(typeof parsed.exit_code).toBe('number');
});

// AT-5.2: matching lib file but no corresponding test file — silent, exit 0
test('H5: lib/bar.js with no test file is silent (AT-5.2)', () => {
  fs.writeFileSync(path.join(fakeProjectDir, 'lib', 'bar.js'), 'module.exports = { bar: 2 };\n');

  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fakeProjectDir, 'lib', 'bar.js') },
    tool_response: { output: '' }
  });

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProjectDir }
  });

  expect(result.status).toBe(0);
  expect(result.stderr.trim()).toBe('');
});

// AT-5.3: unrelated file path — silent, exit 0
test('H5: unrelated file (README.md) exits 0 silently (AT-5.3)', () => {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fakeProjectDir, 'README.md') },
    tool_response: { output: '' }
  });

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProjectDir }
  });

  expect(result.status).toBe(0);
  expect(result.stderr.trim()).toBe('');
});

// AT-5.4: ADVISOR_TEST_ON_EDIT=0 disables the hook
test('H5: ADVISOR_TEST_ON_EDIT=0 disables hook (AT-5.4)', () => {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fakeProjectDir, 'lib', 'foo.js') },
    tool_response: { output: '' }
  });

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProjectDir, ADVISOR_TEST_ON_EDIT: '0' }
  });

  expect(result.status).toBe(0);
  expect(result.stderr.trim()).toBe('');
});

// ── RED tests (new, code-review patches) ───────────────────────────────────

// AT-5.5: subdirectory lib files (e.g. lib/hooks/worker-trace.js) should map to
// tests/hooks/worker-trace.test.js — current regex [^/]+ blocks subdirs.
test('H5: lib/hooks/foo.js edit triggers tests/hooks/foo.test.js (subdir-mapping, RED)', () => {
  fs.mkdirSync(path.join(fakeProjectDir, 'lib', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(fakeProjectDir, 'tests', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(fakeProjectDir, 'lib', 'hooks', 'foo.js'), 'module.exports = { foo: 1 };\n');
  fs.writeFileSync(
    path.join(fakeProjectDir, 'tests', 'hooks', 'foo.test.js'),
    "import { test, expect } from 'bun:test';\ntest('subdir trivial', () => { expect(1).toBe(1); });\n"
  );

  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fakeProjectDir, 'lib', 'hooks', 'foo.js') },
    tool_response: { output: '' }
  });

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: fakeProjectDir }
  });

  expect(result.status).toBe(0);
  const lines = result.stderr.trim().split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  const parsed = JSON.parse(lines[lines.length - 1]);
  expect(parsed.test_file).toBe('tests/hooks/foo.test.js');
});

// AT-5.6: hook source must include a timeout: option on the spawnSync call to
// prevent a hanging test suite from blocking PostToolUse indefinitely.
test('H5: hook source declares spawnSync timeout (timeout-contract, RED)', () => {
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  // The hook must pass an explicit timeout option to spawnSync.
  expect(src).toMatch(/timeout:\s*\d+/);
});
