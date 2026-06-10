// Pins the per-worker advisor-tool policy in lib/summon.js's launch.sh.
//
// Background: `claude` has NO `--advisor` CLI flag in v2.1.170 — it is rejected
// as `unknown option '--advisor'`, and under `set -e` that killed every worker
// at launch. The advisor model is configured via the `advisorModel` SETTING, and
// disabled per-worker via the CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 env var.
//
// Policy:
//   - Fable workers  → HARD-DISABLE the advisor (env export in launch.sh). Fable 5
//     can only pair with a fable advisor (API rejects opus/sonnet for a fable
//     request), and a fable advisor everywhere is expensive overkill.
//   - Every other worker → no per-worker export; inherits the global advisorModel
//     (currently `opus`), the working default.
//
// Coverage (asserts against the built launch.sh):
//   T1  --intelligence 95  (fable band [95,100])  → has CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
//   T1b --model claude-fable-5                     → has CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
//   T2  --intelligence 50  (sonnet band)           → NO disable export
//   T2b --model claude-sonnet-4-6                  → NO disable export
//   T3  no --intelligence, no --model              → NO disable export
//   T4  REGRESSION: no launch.sh, any tier, ever contains `--advisor`

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const TS = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-advdis-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-advdis-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

const DISABLE = 'export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1';

function provision(extraArgs) {
  const sid = `test-advdis-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', 'researcher',
      '--task',  'advisor-disable test — ignore',
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

test('T1: --intelligence 95 (fable band) disables the advisor', () => {
  const { launchSh } = provision(['--intelligence', '95']);
  expect(launchSh).toContain(DISABLE);
});

test('T1b: --model claude-fable-5 disables the advisor', () => {
  const { launchSh } = provision(['--model', 'claude-fable-5']);
  expect(launchSh).toContain(DISABLE);
});

test('T2: --intelligence 50 (sonnet band) does NOT disable the advisor', () => {
  const { launchSh } = provision(['--intelligence', '50']);
  expect(launchSh).not.toContain(DISABLE);
});

test('T2b: --model claude-sonnet-4-6 does NOT disable the advisor', () => {
  const { launchSh } = provision(['--model', 'claude-sonnet-4-6']);
  expect(launchSh).not.toContain(DISABLE);
});

test('T3: no --intelligence and no --model does NOT disable the advisor', () => {
  const { launchSh } = provision([]);
  expect(launchSh).not.toContain(DISABLE);
});

test('T4 (regression): no launch.sh ever passes the non-existent --advisor flag', () => {
  for (const args of [['--intelligence', '95'], ['--intelligence', '50'], ['--model', 'claude-sonnet-4-6'], []]) {
    const { launchSh } = provision(args);
    expect(launchSh).not.toContain('--advisor');
  }
});
