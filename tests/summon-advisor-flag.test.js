// Pins the per-worker --advisor flag in lib/summon.js's claude launch command.
// Rule: a worker whose resolved model is Fable advises with `--advisor fable`;
// every other resolved model advises with `--advisor opus`; when no model is
// resolved (no --intelligence and no --model) the flag is omitted so the worker
// inherits the global advisorModel. Without the flag, a global advisorModel pin
// causes 400 "cannot be used as an advisor" tier mismatches.
//
// Coverage (asserts all three branches against the built launch.sh):
//   T1  --intelligence 95  (fable band [95,100])      → launch.sh has `--advisor fable`
//   T2  --intelligence 50  (sonnet band, lower tier)  → launch.sh has `--advisor opus`
//   T2b --model claude-sonnet-4-6 (non-fable model)   → launch.sh has `--advisor opus`
//   T3  no --intelligence, no --model                 → launch.sh has NO `--advisor`

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const TS = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-advflag-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-advflag-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

function provision(extraArgs) {
  const sid = `test-advflag-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', 'researcher',
      '--task',  'advisor-flag test — ignore',
      '--goal',  'test',
      '--sid',   sid,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
    }
  );
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  const meta = JSON.parse(r.stdout.trim());
  const launchSh = fs.readFileSync(meta.launchScript, 'utf8');
  return { meta, launchSh };
}

test('T1: --intelligence 95 (fable band) emits --advisor fable', () => {
  const { launchSh } = provision(['--intelligence', '95']);
  expect(launchSh).toContain('--advisor fable');
});

test('T2: --intelligence 50 (lower tier) emits --advisor opus', () => {
  const { launchSh } = provision(['--intelligence', '50']);
  expect(launchSh).toContain('--advisor opus');
  expect(launchSh).not.toContain('--advisor fable');
});

test('T2b: --model claude-sonnet-4-6 (non-fable model) emits --advisor opus', () => {
  const { launchSh } = provision(['--model', 'claude-sonnet-4-6']);
  expect(launchSh).toContain('--advisor opus');
});

test('T3: no --intelligence and no --model omits the --advisor flag', () => {
  const { launchSh } = provision([]);
  expect(launchSh).not.toContain('--advisor');
});
