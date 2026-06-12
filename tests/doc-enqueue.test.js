import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;

let tmpRuns;
let tmpQueueDir;

beforeAll(() => {
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-enq-runs-'));
  tmpQueueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-enq-queue-'));
});

afterAll(() => {
  fs.rmSync(tmpRuns, { recursive: true, force: true });
  fs.rmSync(tmpQueueDir, { recursive: true, force: true });
});

// Create a standalone git repo at tmpRuns/sid/workspace with one committed file.
function makeWorktree(sid) {
  const wsPath = path.join(tmpRuns, sid, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  spawnSync('git', ['init'], { cwd: wsPath, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsPath, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: wsPath, stdio: 'ignore' });
  fs.writeFileSync(path.join(wsPath, 'base.txt'), 'base content');
  spawnSync('git', ['add', '.'], { cwd: wsPath, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: wsPath, stdio: 'ignore' });
  return wsPath;
}

function runSynthesize(sid, extraEnv = {}) {
  return spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize',
      '--sid', sid,
      '--seq', '3',
      '--established', 'test established',
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

function readQueue(queueFile) {
  if (!fs.existsSync(queueFile)) return [];
  return fs.readFileSync(queueFile, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

test('coder-style worktree with changes enqueues correct repo-relative paths', () => {
  const sid = `enq-coder-${Date.now()}`;
  const queueFile = path.join(tmpQueueDir, `${sid}.jsonl`);
  const wsPath = makeWorktree(sid);

  // Modify tracked file and add untracked file (no commit — mirrors coder auto-mode)
  fs.writeFileSync(path.join(wsPath, 'base.txt'), 'modified content');
  fs.writeFileSync(path.join(wsPath, 'new-feature.ts'), 'export const x = 1;');

  const result = runSynthesize(sid, { ADVISOR_DOC_QUEUE: queueFile });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');

  const entries = readQueue(queueFile);
  expect(entries.length).toBe(1);

  const entry = entries[0];
  expect(entry.sid).toBe(sid);
  expect(entry.seq).toBe(3);
  expect(entry.established).toBe('test established');
  expect(entry.material).toBe('yes');
  expect(Array.isArray(entry.modified_files)).toBe(true);
  expect(entry.modified_files).toContain('base.txt');
  expect(entry.modified_files).toContain('new-feature.ts');
}, TEST_TIMEOUT);

test('no-changes case skips enqueue', () => {
  const sid = `enq-nochange-${Date.now()}`;
  const queueFile = path.join(tmpQueueDir, `${sid}.jsonl`);
  makeWorktree(sid); // clean worktree, no uncommitted changes

  const result = runSynthesize(sid, { ADVISOR_DOC_QUEUE: queueFile });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');

  const entries = readQueue(queueFile);
  expect(entries.length).toBe(0);
}, TEST_TIMEOUT);

test('git failure skips enqueue without throwing', () => {
  // sid with no workspace dir — git commands will fail
  const sid = `enq-gitfail-${Date.now()}`;
  const queueFile = path.join(tmpQueueDir, `${sid}.jsonl`);
  // No makeWorktree — workspace path does not exist

  const result = runSynthesize(sid, { ADVISOR_DOC_QUEUE: queueFile });
  // synthesize must still succeed
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');

  // No queue entries because git failed gracefully
  const entries = readQueue(queueFile);
  expect(entries.length).toBe(0);
}, TEST_TIMEOUT);
