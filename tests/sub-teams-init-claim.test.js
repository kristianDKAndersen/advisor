import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const INIT_JS  = path.resolve(import.meta.dir, '../sub-teams/lib/init.js');
const CLAIM_JS = path.resolve(import.meta.dir, '../sub-teams/lib/claim.js');

let tmpDir;
afterAll(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeRun(tasks) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-teams-init-claim-'));
  const state = JSON.stringify({
    run_id: 'test-run', phase: 'initializing', teammate_roles: ['teammate-1'],
    ts_started: Math.floor(Date.now() / 1000), ts_updated: Math.floor(Date.now() / 1000),
    done_roles: [], stalls: []
  });
  const r = spawnSync('bun', [INIT_JS, '--run-dir', tmpDir, '--state', state, '--tasks', JSON.stringify(tasks)],
    { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return tmpDir;
}

test('init.js writes task-list.json in {tasks:[...]} format', () => {
  const runDir = makeRun([{
    id: 't1', description: 'test', input: { description: 'test', context: '', goal: 'done' },
    deps: [], status: 'pending', claimed_by: null, claimed_at: null,
    assigned_teammate: 'teammate-1', output: null, error: null, completed_at: null
  }]);
  const list = JSON.parse(fs.readFileSync(path.join(runDir, 'task-list.json'), 'utf8'));
  expect(list).toHaveProperty('tasks');
  expect(Array.isArray(list.tasks)).toBe(true);
  expect(list.tasks[0].id).toBe('t1');
});

test('claim.js claims assigned task from init.js output (end-to-end)', () => {
  const runDir = makeRun([{
    id: 't1', description: 'test', input: { description: 'test', context: '', goal: 'done' },
    deps: [], status: 'pending', claimed_by: null, claimed_at: null,
    assigned_teammate: 'teammate-1', output: null, error: null, completed_at: null
  }]);
  const r = spawnSync('bun', [CLAIM_JS, '--run-dir', runDir, '--role', 'teammate-1'],
    { encoding: 'utf8' });
  // Should claim successfully with task_id
  const parsed = JSON.parse(r.stdout.trim());
  expect(r.status).toBe(0);
  expect(parsed).toHaveProperty('task_id', 't1');
  expect(parsed.status).toBe('in_progress');
});
