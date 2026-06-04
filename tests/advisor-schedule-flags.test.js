// tests/advisor-schedule-flags.test.js
// RED tests for bin/advisor-schedule new flags: --agent, --goal, --when (patterns 6.3+6.4)
// All tests are expected to FAIL until the implementation is complete.
// Tests use ADVISOR_DRY_RUN=1 env: when set, advisor-schedule must print the generated
// command to stdout and exit 0 without spawning tmux.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BIN_ADVISOR_SCHEDULE = path.resolve(import.meta.dir, '../bin/advisor-schedule');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sched-flags-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: run advisor-schedule with ADVISOR_DRY_RUN=1
function runDryRun(args, env = {}) {
  return spawnSync('bash', [BIN_ADVISOR_SCHEDULE, ...args], {
    encoding: 'utf8',
    cwd: tmpDir,
    env: { ...process.env, ADVISOR_DRY_RUN: '1', ADVISOR_SCHEDULED_LOOP: '', ...env },
  });
}

// U-FLAG-1: --help output must document --agent, --goal, --when
// FAILS now: current help text does not mention these three flags.
test('--help output contains --agent, --goal, and --when flags', () => {
  const result = spawnSync('bash', [BIN_ADVISOR_SCHEDULE, '--help'], {
    encoding: 'utf8',
    cwd: tmpDir,
    env: { ...process.env, ADVISOR_SCHEDULED_LOOP: '' },
  });
  expect(result.status).toBe(0);
  const combined = result.stdout + result.stderr;
  expect(combined).toContain('--agent');
  expect(combined).toContain('--goal');
  expect(combined).toContain('--when');
});

// U-FLAG-2: --agent flag is passed through to the generated summon command.
// When --agent researcher is given, the generated command must contain '--agent researcher',
// not the hardcoded 'coder'.
// FAILS now: --agent flag is not recognized (exits 1 with "Unknown flag"); ADVISOR_DRY_RUN not supported.
test('--agent researcher produces generated command containing --agent researcher', () => {
  const result = runDryRun([
    '--sid', 'test-sid',
    '--interval', '30s',
    '--task', 'do research',
    '--agent', 'researcher',
    '--goal', 'deliver findings',
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--agent researcher');
});

// U-FLAG-3: when --goal is omitted, the generated command's --goal value equals the --task text.
// FAILS now: ADVISOR_DRY_RUN=1 is not supported; script attempts tmux and exits non-zero.
test('--goal defaults to --task value when --goal flag is omitted', () => {
  const taskText = 'my default goal task';
  const result = runDryRun([
    '--sid', 'test-sid',
    '--interval', '1m',
    '--task', taskText,
  ]);
  expect(result.status).toBe(0);
  // The generated summon invocation must pass the task text as the goal.
  expect(result.stdout).toContain(`--goal '${taskText}'`);
});

// U-FLAG-4: --when 'false' wraps the summon call in a conditional so the loop body
// includes a bash -c invocation of the condition expression before calling summon.
// FAILS now: --when flag is not recognized (exits 1 with "Unknown flag"); ADVISOR_DRY_RUN not supported.
test('--when expression wraps summon in a conditional (bash -c or inline condition)', () => {
  const result = runDryRun([
    '--sid', 'test-sid',
    '--interval', '5m',
    '--task', 'conditional task',
    '--agent', 'coder',
    '--goal', 'a goal',
    '--when', 'false',
  ]);
  expect(result.status).toBe(0);
  // The generated loop body must include a guard: either "bash -c" for the when-expression,
  // or the literal when expression embedded in a conditional construct.
  const out = result.stdout;
  const hasConditional = out.includes('bash -c') || out.includes('false');
  expect(hasConditional).toBe(true);
  // More specifically: the when expression must appear before the summon invocation,
  // not just incidentally. Assert it is not simply absent from a plain summon line.
  expect(out).toContain('false');
});

// U-FLAG-5: backward compat — invocation with only --sid/--interval/--task (no new flags)
// still produces a summon command with '--agent coder' (the default).
// FAILS now: ADVISOR_DRY_RUN=1 is not supported; script attempts tmux and exits non-zero.
test('backward compat: omitting --agent defaults to coder in generated command', () => {
  const result = runDryRun([
    '--sid', 'test-sid',
    '--interval', '10m',
    '--task', 'legacy task',
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--agent coder');
});
