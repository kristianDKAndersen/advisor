import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(REPO, 'lib', 'tab-trace.sh');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-trace-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const logPath = () => path.join(tmpDir, '.advisor', 'state', 'tab-close-trace.log');

function runTrace(action, tty, extraEnv = {}) {
  return spawnSync(
    'bash',
    ['-c', 'source "$SCRIPT"; _tab_trace "$TEST_ACTION" "$TEST_TTY"'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmpDir,
        SCRIPT,
        TEST_ACTION: action || '',
        TEST_TTY: tty || '',
        ...extraEnv,
      },
    }
  );
}

test('T1: creates log dir and file on first call', () => {
  runTrace('action1', '/dev/pts/1');
  expect(fs.existsSync(logPath())).toBe(true);
});

test('T2: log line matches expected format', () => {
  runTrace('open', '/dev/pts/1', { sid: 'testsid' });
  const line = fs.readFileSync(logPath(), 'utf8').trim();
  expect(line).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \S+ sid=testsid tty=\/dev\/pts\/1 action=open$/
  );
});

test('T3: sid defaults to - when unset', () => {
  // strip any inherited sid from parent env
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'sid'));
  spawnSync(
    'bash',
    ['-c', 'source "$SCRIPT"; _tab_trace "$TEST_ACTION" "$TEST_TTY"'],
    {
      encoding: 'utf8',
      env: { ...baseEnv, HOME: tmpDir, SCRIPT, TEST_ACTION: 'ping', TEST_TTY: '/dev/pts/1' },
    }
  );
  const log = fs.readFileSync(logPath(), 'utf8');
  expect(log).toContain('sid=-');
});

test('T4: tty defaults to - when $2 is omitted', () => {
  spawnSync(
    'bash',
    ['-c', 'source "$SCRIPT"; _tab_trace "$TEST_ACTION"'],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpDir, SCRIPT, sid: 'mysid', TEST_ACTION: 'myaction' },
    }
  );
  const log = fs.readFileSync(logPath(), 'utf8');
  expect(log).toContain('tty=-');
});

test('T5: appends (does not overwrite) on repeated calls', () => {
  spawnSync(
    'bash',
    ['-c', 'source "$SCRIPT"; _tab_trace call1; _tab_trace call2; _tab_trace call3'],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpDir, SCRIPT },
    }
  );
  const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
  expect(lines.length).toBe(3);
});

test('T6: no error when log dir already exists', () => {
  fs.mkdirSync(path.join(tmpDir, '.advisor', 'state'), { recursive: true });
  const r = runTrace('second', '/dev/pts/0');
  expect(r.status).toBe(0);
  expect(r.stderr).toBe('');
});
