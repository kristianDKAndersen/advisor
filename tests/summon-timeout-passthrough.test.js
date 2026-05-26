// Pins the --timeoutSec flag pipeline from lib/summon.js so it cannot regress
// back to "silently dropped" — the bug that killed two planner spawns at the
// 300s tmux-runner safety net (sids 1779350057-848289 and 1779351545-b4d176).
//
// Coverage:
//   T1  --timeoutSec 1500  → meta JSON returned on stdout contains timeoutSec:1500
//   T2  --timeoutSec 1500  → meta.json on disk contains timeoutSec:1500
//   T3  no --timeoutSec    → meta JSON omits the field (the bash wrapper supplies
//                            the user-facing default; lib/summon.js itself does not)

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const TS = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-tmout-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-tmout-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

function provision(extraArgs) {
  const sid = `test-tmout-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', 'researcher',
      '--task',  'timeout-passthrough test — ignore',
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
  const metaOnDisk = JSON.parse(
    fs.readFileSync(path.join(RUNS_TMP, sid, 'meta.json'), 'utf8')
  );
  return { meta, metaOnDisk };
}

test('T1: --timeoutSec 1500 surfaces in stdout meta JSON', () => {
  const { meta } = provision(['--timeoutSec', '1500']);
  expect(meta.timeoutSec).toBe(1500);
});

test('T2: --timeoutSec 1500 persists to meta.json on disk', () => {
  const { metaOnDisk } = provision(['--timeoutSec', '1500']);
  expect(metaOnDisk.timeoutSec).toBe(1500);
});

test('T3: omitting --timeoutSec leaves the field unset in meta JSON', () => {
  const { meta, metaOnDisk } = provision([]);
  expect(meta.timeoutSec).toBeUndefined();
  expect(metaOnDisk.timeoutSec).toBeUndefined();
});

// --timeout alias tests (new short-form CLI flag)
test('T4: --timeout 1200 surfaces as timeoutSec:1200 in stdout meta JSON', () => {
  const { meta } = provision(['--timeout', '1200']);
  expect(meta.timeoutSec).toBe(1200);
});

test('T5: --timeout 30 (below 60s min) is clamped to 60', () => {
  const { meta } = provision(['--timeout', '30']);
  expect(meta.timeoutSec).toBe(60);
});

test('T6: --timeout 7200 (above 3600s max) is clamped to 3600', () => {
  const { meta } = provision(['--timeout', '7200']);
  expect(meta.timeoutSec).toBe(3600);
});
