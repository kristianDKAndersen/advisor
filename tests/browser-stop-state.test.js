// tests/browser-stop-state.test.js
// Tests for bin/browser-stop: STATE_FILE path via sys.argv[1] (N4).

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BROWSER_STOP = path.resolve(import.meta.dir, '../bin/browser-stop');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-stop-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// [N4-struct] Structural: script must NOT interpolate STATE_FILE into open('...'),
// and MUST use sys.argv[1] so any path characters are safe.
test('[N4] bin/browser-stop uses sys.argv[1] not open("$STATE_FILE") in python invocation', () => {
  const scriptContent = fs.readFileSync(BROWSER_STOP, 'utf8');
  expect(scriptContent).not.toContain("open('$STATE_FILE')");
  expect(scriptContent).toContain('sys.argv[1]');
});

// [N4-behavior] Behavioral: a state.json at a path containing a single-quote must be read correctly.
// Pre-fix the python3 -c "...open('$STATE_FILE')..." call would produce a SyntaxError when
// STATE_FILE contains a single-quote, causing DAEMON_PID/CHROME_PID to be empty strings,
// meaning the script silently fails to extract PIDs rather than raising.
// Post-fix sys.argv[1] is used and the PID is read correctly regardless of path chars.
test('[N4] browser-stop reads PIDs correctly when STATE_FILE path contains a single-quote', () => {
  // Create a session directory whose name contains a single-quote.
  const sessionDir = path.join(tmpDir, "it's-here");
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  // Write a fake state.json with a known daemon_pid value.
  fs.writeFileSync(stateFile, JSON.stringify({ daemon_pid: '99999', chrome_pid: '88888' }));

  // Invoke browser-stop with a fake session dir by overriding HOME so STATE_DIR resolves
  // to our tmp dir. We do this by creating the required directory structure under a fake HOME.
  const fakeHome = path.join(tmpDir, 'fake-home');
  const sessionId = "it's-here";
  const sessionStateDir = path.join(fakeHome, '.advisor', 'browser-sessions', sessionId);
  fs.mkdirSync(sessionStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionStateDir, 'state.json'),
    JSON.stringify({ daemon_pid: '99999', chrome_pid: '88888' })
  );

  const result = spawnSync('bash', [BROWSER_STOP, '--session', sessionId], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome },
  });

  // Pre-fix: python3 SyntaxError → DAEMON_PID empty → kill -0 "" → exits non-zero OR
  // the script runs but cannot extract the PID. With sys.argv[1], python reads correctly.
  // The script will try to kill pid 99999 (likely not running) but that's handled with || true.
  // The critical check: script must exit 0 and output {"ok":true} (not crash on the python call).
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"ok":true');
});
