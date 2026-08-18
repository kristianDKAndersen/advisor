const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, beforeEach, afterEach } = require('bun:test');
const {
  stateFilePath,
  initRoundState,
  readRoundState,
  writeRoundState,
  validateRoundState,
  appendRound,
  noImprovementInLastK,
} = require('../lib/round-state');

let outputDir;

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-state-test-'));
});

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

const initFields = {
  schema_version: '1',
  run_id: 'lqz3k-a4f9',
  goal: 'The rendered dashboard matches the reference pixel-for-pixel.',
  bar: { type: 'external-reference', ref: '/tmp/reference/metrics-target.png' },
  head_sha: '9c1e4b7a2f0d8e63a1b5c4d7e9f0a1b2c3d4e5f6',
  test_command: 'npx vitest run tests/metrics.spec.ts',
  safety_gate_path: '/tmp/safety-gate.json',
  max_rounds: 5,
  cost_ceiling_usd: 12.0,
  no_improve_k: 2,
  autonomy_level: 'L2',
};

function makeRound(round, gap, overallPass) {
  return {
    round,
    builder_sid: `sid-${round}`,
    builder_status: 'result',
    builder_verdict: 'partial',
    artifacts: ['/tmp/worktree/src/views/metrics.vue'],
    files_changed: ['src/views/metrics.vue'],
    test_state: { passed: false, exit_code: 1, output_tail: 'x' },
    critic_sid: `critic-${round}`,
    ab_verdict: { winner: 'bar', margin: 'narrow', single_biggest_gap: gap },
    scores: { overall_pass: overallPass },
    single_biggest_gap: gap,
    failure_category: null,
    round_cost_usd: 1.0,
    started_at: '2026-08-07T14:00:00Z',
    ended_at: '2026-08-07T14:10:00Z',
  };
}

test('initRoundState writes a valid schema atomically and readRoundState round-trips it', () => {
  const state = initRoundState(outputDir, initFields);
  expect(fs.existsSync(stateFilePath(outputDir))).toBe(true);
  expect(fs.existsSync(stateFilePath(outputDir) + '.tmp')).toBe(false);
  expect(state.rounds).toEqual([]);
  expect(state.current_round).toBe(0);
  expect(state.status).toBe('running');

  const loaded = readRoundState(outputDir);
  expect(loaded).toEqual(state);
});

test('validateRoundState accepts a fully populated state', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  const result = validateRoundState(state);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('validateRoundState rejects a state missing required top-level fields', () => {
  const result = validateRoundState({ schema_version: '1' });
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('run_id'))).toBe(true);
  expect(result.errors.some((e) => e.includes('rounds'))).toBe(true);
});

test('validateRoundState rejects a round record missing required fields', () => {
  initRoundState(outputDir, initFields);
  const s = readRoundState(outputDir);
  s.rounds.push({ round: 0 });
  const result = validateRoundState(s);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('rounds[0]'))).toBe(true);
});

test('appendRound persists the record to disk (survives reload)', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  const reloaded = readRoundState(outputDir);
  expect(reloaded.rounds.length).toBe(1);
  expect(reloaded.rounds[0].round).toBe(0);
});

test('noImprovementInLastK returns false when fewer than K rounds exist', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  expect(noImprovementInLastK(state, 2)).toBe(false);
});

test('noImprovementInLastK returns true when the last K rounds share the same unresolved gap', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  appendRound(outputDir, state, makeRound(1, 'gap A', false));
  expect(noImprovementInLastK(state, 2)).toBe(true);
});

test('noImprovementInLastK returns false when the gap changed between rounds (progress made)', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  appendRound(outputDir, state, makeRound(1, 'gap B', false));
  expect(noImprovementInLastK(state, 2)).toBe(false);
});

test('noImprovementInLastK returns false once a round passes', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  appendRound(outputDir, state, makeRound(1, 'gap A', true));
  expect(noImprovementInLastK(state, 2)).toBe(false);
});

test('noImprovementInLastK treats ab_verdict.winner=="candidate" as passed even with no scores object', () => {
  const state = initRoundState(outputDir, initFields);
  const losing = makeRound(0, 'gap A', false);
  const winningNoScores = {
    ...makeRound(1, 'gap A', false),
    ab_verdict: { winner: 'candidate', margin: 'clear', single_biggest_gap: '' },
    scores: null,
  };
  appendRound(outputDir, state, losing);
  appendRound(outputDir, state, winningNoScores);
  expect(noImprovementInLastK(state, 2)).toBe(false);
});

test('noImprovementInLastK treats scores.overall_pass==true as passed even with no ab_verdict', () => {
  const state = initRoundState(outputDir, initFields);
  const losing = makeRound(0, 'gap A', false);
  const passingNoAbVerdict = {
    ...makeRound(1, 'gap A', true),
    ab_verdict: null,
  };
  appendRound(outputDir, state, losing);
  appendRound(outputDir, state, passingNoAbVerdict);
  expect(noImprovementInLastK(state, 2)).toBe(false);
});

test('noImprovementInLastK still fires the breaker when K rounds all lose with the identical gap', () => {
  const state = initRoundState(outputDir, initFields);
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  appendRound(outputDir, state, makeRound(1, 'gap A', false));
  expect(noImprovementInLastK(state, 2)).toBe(true);
});

test('writeRoundState overwrites the file atomically leaving no .tmp residue', () => {
  const state = initRoundState(outputDir, initFields);
  state.current_round = 3;
  writeRoundState(outputDir, state);
  expect(fs.existsSync(stateFilePath(outputDir) + '.tmp')).toBe(false);
  expect(readRoundState(outputDir).current_round).toBe(3);
});

test('initRoundState persists fields.agent when supplied and readRoundState returns it', () => {
  const state = initRoundState(outputDir, { ...initFields, agent: 'reviewer' });
  expect(state.agent).toBe('reviewer');
  expect(readRoundState(outputDir).agent).toBe('reviewer');
});

test('initRoundState defaults agent to "coder" when fields.agent is not supplied', () => {
  const state = initRoundState(outputDir, initFields);
  expect(state.agent).toBe('coder');
  expect(readRoundState(outputDir).agent).toBe('coder');
});

test('validateRoundState accepts a state with no agent key (pre-existing round_state.json files remain resumable)', () => {
  const state = initRoundState(outputDir, initFields);
  delete state.agent;
  const result = validateRoundState(state);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('agent survives a write-then-read round-trip after appendRound mutates the state', () => {
  const state = initRoundState(outputDir, { ...initFields, agent: 'reviewer' });
  appendRound(outputDir, state, makeRound(0, 'gap A', false));
  writeRoundState(outputDir, state);
  expect(readRoundState(outputDir).agent).toBe('reviewer');
});
