import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const TOOL_GUARD = path.resolve(import.meta.dir, '../lib/tool-guard.js');

let tmpRuns;

beforeAll(() => {
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sub-'));
});

afterAll(() => {
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

function invoke(toolName, toolInput, sid, extraEnv = {}) {
  return spawnSync('node', [TOOL_GUARD], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      ADVISOR_SID: sid,
      ADVISOR_RUNS_ROOT: tmpRuns,
      ...extraEnv,
    },
  });
}

test('checkDuplicate via subprocess: count persists across invocations and halts at 3', () => {
  const sid = `b1-halt-${Date.now()}`;
  const input = { command: 'echo dedup-test' };

  const r1 = invoke('Bash', input, sid);
  expect(r1.status).toBe(0);

  const r2 = invoke('Bash', input, sid);
  expect(r2.status).toBe(0);

  const r3 = invoke('Bash', input, sid);
  expect(r3.status).toBe(2);
  expect(r3.stdout).toContain('tool-guard: loop detected');
});

test('checkDuplicate via subprocess: different args do not cross-count', () => {
  const sid = `b1-diff-${Date.now()}`;

  invoke('Bash', { command: 'echo a' }, sid);
  invoke('Bash', { command: 'echo a' }, sid);

  // Different tool input — should not trigger
  const rDiff = invoke('Bash', { command: 'echo b' }, sid);
  expect(rDiff.status).toBe(0);

  // 3rd identical call — should trigger
  const r3 = invoke('Bash', { command: 'echo a' }, sid);
  expect(r3.status).toBe(2);
  expect(r3.stdout).toContain('tool-guard: loop detected');
});

test('stale orphaned tool-counts-lock is cleared and count increments correctly', () => {
  const sid = `stale-tg-${Date.now()}`;
  const lockDir = path.join(tmpRuns, sid, '.tool-counts.lock');

  // Simulate an orphaned lock dir left by a hard-killed process (15 s old).
  fs.mkdirSync(lockDir, { recursive: true });
  const staleTime = new Date(Date.now() - 15000);
  fs.utimesSync(lockDir, staleTime, staleTime);

  const t0 = Date.now();
  const r = invoke('Bash', { command: 'echo stale-test' }, sid);
  const elapsed = Date.now() - t0;

  expect(r.status).toBe(0); // must succeed
  expect(elapsed).toBeLessThan(2000); // well under the 5 s deadline

  // Count must have been written — stale lock was cleared and increment ran.
  const countsPath = path.join(tmpRuns, sid, 'tool-counts.json');
  expect(fs.existsSync(countsPath)).toBe(true);
  const counts = JSON.parse(fs.readFileSync(countsPath, 'utf8'));
  const values = Object.values(counts);
  expect(values.length).toBeGreaterThan(0);
  expect(values[0]).toBe(1);
});

test('checkDuplicate via subprocess: absent ADVISOR_SID exits 0 (fail-open)', () => {
  for (let i = 0; i < 5; i++) {
    const r = spawnSync('node', [TOOL_GUARD], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo loop' } }),
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH },
    });
    expect(r.status).toBe(0);
  }
});
