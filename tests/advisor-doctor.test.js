// tests/advisor-doctor.test.js
// RED: all tests are expected to FAIL until skills/advisor-doctor/scripts/diagnose.sh is created.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCRIPT_PATH = path.resolve(import.meta.dir, '../skills/advisor-doctor/scripts/diagnose.sh');

let tmpDir;
let sid;
let runDir;
let result; // cached single run

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-doctor-test-'));
  sid = 'test-doctor-' + Date.now();
  runDir = path.join(tmpDir, sid);

  // session.json with decomposition[] + next_action
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'session.json'),
    JSON.stringify({
      decomposition: [
        { id: 'unit-1', status: 'complete' },
        { id: 'unit-2', status: 'in_progress' },
        { id: 'unit-3', status: 'pending' },
      ],
      next_action: 'check results',
    }),
  );

  // channel/outbox.jsonl — 6 lines so the script tails 5
  const channelDir = path.join(runDir, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const msgs = [
    { type: 'task',     body: 'do work',  from: 'advisor', seq: 1 },
    { type: 'progress', body: 'step 1',   from: 'coder',   seq: 2 },
    { type: 'progress', body: 'step 2',   from: 'coder',   seq: 3 },
    { type: 'progress', body: 'step 3',   from: 'coder',   seq: 4 },
    { type: 'result',   body: 'done',     from: 'coder',   seq: 5 },
    { type: 'result',   body: 'final',    from: 'coder',   seq: 6 },
  ];
  fs.writeFileSync(
    path.join(channelDir, 'outbox.jsonl'),
    msgs.map(m => JSON.stringify(m)).join('\n') + '\n',
  );

  // workspace/ — empty
  fs.mkdirSync(path.join(runDir, 'workspace'), { recursive: true });

  // Run the script once; cache for all tests
  result = spawnSync('bash', [SCRIPT_PATH, '--sid', sid], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: tmpDir },
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('diagnose.sh exits 0', () => {
  expect(result.status).toBe(0);
});

test('diagnose.sh output contains session.json mtime', () => {
  expect(result.stdout).toMatch(/mtime/i);
});

test('diagnose.sh output contains decomposition statuses', () => {
  expect(result.stdout).toContain('complete');
  expect(result.stdout).toContain('in_progress');
  expect(result.stdout).toContain('pending');
});

test('diagnose.sh output contains last-5 outbox message types', () => {
  // 6 lines total; last 5 are: progress, progress, progress, result, result
  // The first line (type=task) is excluded from the tail
  expect(result.stdout).toContain('progress');
  expect(result.stdout).toContain('result');
});

test('diagnose.sh output contains explicit "tmux sessions matching pattern: N" line', () => {
  expect(result.stdout).toMatch(/tmux sessions matching pattern:\s*\d+/i);
});

test('diagnose.sh output contains next_action value', () => {
  expect(result.stdout).toContain('check results');
});
