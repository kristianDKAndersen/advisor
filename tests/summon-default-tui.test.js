// tests/summon-default-tui.test.js
// Tests for ADVISOR_DEFAULT_TUI and ADVISOR_NO_TIMELINE env-gated defaults in bin/summon.
// Uses ADVISOR_DRY_RUN=1: when set, bin/summon prints branch/timeline selection and exits 0
// without provisioning a workspace or spawning any process.

import { test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import path from 'path';

const BIN_SUMMON = path.resolve(import.meta.dir, '../bin/summon');

const BASE_ARGS = [
  '--agent', 'coder',
  '--task', 'dry run test task',
  '--goal', 'dry run goal',
];

function runDryRun(extraArgs = [], env = {}) {
  return spawnSync('bash', [BIN_SUMMON, ...BASE_ARGS, ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADVISOR_DRY_RUN: '1',
      ADVISOR_DEFAULT_TUI: '',
      ADVISOR_NO_TIMELINE: '',
      ADVISOR_TMUX_MULTIPLEX: '',
      ...env,
    },
  });
}

// T1: ADVISOR_DEFAULT_TUI=1 routes a non-ensemble summon to the tui branch.
test('ADVISOR_DEFAULT_TUI=1 selects tui branch for non-ensemble call', () => {
  const result = runDryRun([], { ADVISOR_DEFAULT_TUI: '1' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('branch:tui');
});

// T2: ADVISOR_DEFAULT_TUI=1 is bypassed when --ensemble is given; headless fan-out wins.
test('ADVISOR_DEFAULT_TUI=1 skipped when --ensemble is given', () => {
  const result = runDryRun(['--ensemble', '3'], { ADVISOR_DEFAULT_TUI: '1' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('branch:headless');
});

// T3: --headless overrides ADVISOR_DEFAULT_TUI=1 and forces the headless branch.
test('--headless flag overrides ADVISOR_DEFAULT_TUI=1', () => {
  const result = runDryRun(['--headless'], { ADVISOR_DEFAULT_TUI: '1' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('branch:headless');
});

// T4: ADVISOR_NO_TIMELINE=1 suppresses the timeline block (equivalent to --no-timeline).
test('ADVISOR_NO_TIMELINE=1 suppresses timeline', () => {
  const result = runDryRun([], { ADVISOR_NO_TIMELINE: '1' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('timeline:suppressed');
});
