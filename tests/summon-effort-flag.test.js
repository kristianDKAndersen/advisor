// Pins the --effort <level> passthrough: lib/summon.js resolves resolvedReasoning
// from the intelligence band and stores it in session meta, but must ALSO inject
// it into the launched claude command as --effort <level> — otherwise the band's
// reasoning setting is stored but never actuated.
//
// Coverage:
//   E1  --intelligence 50 (-> sonnet medium band) → launch.sh contains '--effort medium'
//   E2  no --intelligence, no --model            → launch.sh contains NO '--effort'
//       (existing summons must be byte-for-byte unchanged)

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const TS = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-effort-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-effort-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

function provision(extraArgs) {
  const sid = `test-effort-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', 'researcher',
      '--task',  'effort-flag test — ignore',
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
  const launchScript = fs.readFileSync(path.join(RUNS_TMP, sid, 'launch.sh'), 'utf8');
  return { launchScript };
}

test("E1: --intelligence 50 (sonnet medium band) injects --effort 'medium' into launch.sh", () => {
  const { launchScript } = provision(['--intelligence', '50']);
  expect(launchScript).toContain("--effort 'medium'");
});

test('E2: no --intelligence, no --model omits --effort from launch.sh entirely', () => {
  const { launchScript } = provision([]);
  expect(launchScript).not.toContain('--effort');
});
