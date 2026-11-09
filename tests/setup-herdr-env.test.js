import { test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import path from 'path';

const REPO = path.resolve(import.meta.dir, '..');
const PRELOAD = path.join(REPO, 'tests', 'setup-no-reaper.js');
const PROBE = path.join(REPO, 'tests', 'fixtures', 'herdr-env-probe.js');
const GATE = { ADVISOR_HERDR: '1', HERDR_ENV: '1' };

function runProbe(withPreload) {
  const args = withPreload ? ['--preload', PRELOAD, PROBE] : [PROBE];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO,
    env: { ...process.env, ...GATE },
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout.trim());
}

test('preload has already deleted the herdr gate in this test process', () => {
  expect(process.env.ADVISOR_HERDR).toBeUndefined();
  expect(process.env.HERDR_ENV).toBeUndefined();
});

test('a process started with the gate exported and the preload sees no gate', () => {
  const env = runProbe(true);
  expect(env.ADVISOR_HERDR).toBeNull();
  expect(env.HERDR_ENV).toBeNull();
  expect(env.ADVISOR_NO_REAPER).toBe('1');
});

test('control: without the preload the probe sees the exported gate', () => {
  const env = runProbe(false);
  expect(env.ADVISOR_HERDR).toBe('1');
  expect(env.HERDR_ENV).toBe('1');
});
