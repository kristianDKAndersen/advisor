// Pins the --session-id passthrough that lets pollSentinel (lib/tmux-runner.js)
// tell a worker's own Stop-hook payload apart from a same-cwd nested `claude`
// child's by session_id instead of cwd alone (see tests/tmux-runner.test.js
// "pollSentinel: session_id ownership beats same-cwd nested claude" for the
// pollSentinel-level coverage). This file pins the summon.js half: the launch
// line must carry --session-id <uuid>, and that same uuid must land in
// meta.json as claudeSessionId so tmux-runner.js (readOwnerSessionId) can
// find it from runDir alone.

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const TS = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sid-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sid-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

function provision() {
  const sid = `test-sentinel-sid-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', 'researcher',
      '--task',  'sentinel-session-id test — ignore',
      '--goal',  'test',
      '--sid',   sid,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
    }
  );
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  const launchScript = fs.readFileSync(path.join(RUNS_TMP, sid, 'launch.sh'), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(RUNS_TMP, sid, 'meta.json'), 'utf8'));
  return { launchScript, meta, sid };
}

test('launch.sh carries --session-id <uuid> matching meta.json claudeSessionId', () => {
  const { launchScript, meta } = provision();
  expect(typeof meta.claudeSessionId).toBe('string');
  expect(meta.claudeSessionId.length).toBeGreaterThan(0);
  expect(launchScript).toContain(`--session-id '${meta.claudeSessionId}'`);
});

test('each summon generates a distinct claudeSessionId (no reuse across sids)', () => {
  const a = provision();
  const b = provision();
  expect(a.meta.claudeSessionId).not.toBe(b.meta.claudeSessionId);
});
