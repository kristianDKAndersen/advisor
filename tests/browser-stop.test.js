import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'browser-stop');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-stop-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(flags = []) {
  return spawnSync('bash', [BIN, ...flags], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpDir },
    timeout: 10000,
  });
}

function createSession(sessionName, stateData) {
  const dir = path.join(tmpDir, '.advisor', 'browser-sessions', sessionName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(stateData));
  return dir;
}

// PID guaranteed to be non-existent (macOS max PID is 99998 by default)
const DEAD_PID = '99999999';

test('T1: missing --session flag exits 1 with JSON error on stderr', () => {
  const r = run([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('--session is required');
});

test('T2: unknown flag exits 1 with "unknown flag" on stderr', () => {
  const r = run(['--bad-flag']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('unknown flag');
});

test('T3: session not found exits 1 with JSON ok:false and session not found on stdout', () => {
  const r = run(['--session', 'does-not-exist']);
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/"ok"\s*:\s*false/);
  expect(r.stdout).toContain('session not found');
});

test('T4: valid session with no socket exits 0 with {"ok":true}', () => {
  createSession('mysession', { daemon_pid: DEAD_PID, chrome_pid: DEAD_PID });
  const r = run(['--session', 'mysession']);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('{"ok":true}\n');
});

test('T5: socket as regular file - script completes with {"ok":true}', () => {
  const dir = createSession('sock-session', { daemon_pid: DEAD_PID, chrome_pid: DEAD_PID });
  const sockPath = path.join(dir, 'daemon.sock');
  fs.writeFileSync(sockPath, '');
  const r = run(['--session', 'sock-session']);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('{"ok":true}\n');
});

test('T6: socket file removed after stop', () => {
  const dir = createSession('rm-session', { daemon_pid: DEAD_PID, chrome_pid: DEAD_PID });
  const sockPath = path.join(dir, 'daemon.sock');
  fs.writeFileSync(sockPath, '');
  run(['--session', 'rm-session']);
  expect(fs.existsSync(sockPath)).toBe(false);
});
