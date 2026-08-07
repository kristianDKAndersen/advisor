const { test, expect } = require('bun:test');
const { decide, classifyPaneDeath } = require('../lib/loop-termination');

const baseFields = {
  schema_version: '1',
  run_id: 'lqz3k-a4f9',
  goal: 'The rendered dashboard matches the reference pixel-for-pixel.',
  bar: { type: 'external-reference', ref: '/tmp/reference/metrics-target.png' },
  worktree_path: '/tmp/worktree',
  head_sha: '9c1e4b7a2f0d8e63a1b5c4d7e9f0a1b2c3d4e5f6',
  test_command: 'npx vitest run tests/metrics.spec.ts',
  safety_gate_path: '/tmp/safety-gate.json',
  autonomy_level: 'L2',
};

function makeState(overrides = {}) {
  return {
    ...baseFields,
    max_rounds: 5,
    cost_ceiling_usd: 12.0,
    no_improve_k: 2,
    current_round: 1,
    status: 'running',
    cumulative_cost_usd: 1.0,
    escalation: null,
    rounds: [],
    ...overrides,
  };
}

function makeRound(round, overrides = {}) {
  return {
    round,
    builder_sid: `sid-${round}`,
    builder_status: 'result',
    builder_verdict: 'partial',
    artifacts: ['/tmp/worktree/src/views/metrics.vue'],
    files_changed: ['src/views/metrics.vue'],
    test_state: { passed: false, exit_code: 1, output_tail: `tail-${round}` },
    critic_sid: `critic-${round}`,
    ab_verdict: { winner: 'bar', margin: 'narrow', single_biggest_gap: 'colors' },
    scores: { overall_pass: false },
    single_biggest_gap: 'colors',
    failure_category: null,
    round_cost_usd: 1.0,
    started_at: '2026-08-07T14:00:00Z',
    ended_at: '2026-08-07T14:10:00Z',
    ...overrides,
  };
}

// --- Primary exit: blind win ---

test('decide returns status:won when the critic picks the candidate', () => {
  const state = makeState({
    current_round: 1,
    rounds: [makeRound(1, { ab_verdict: { winner: 'candidate', margin: 'clear', single_biggest_gap: null } })],
  });
  const result = decide(state);
  expect(result.status).toBe('won');
  expect(result.escalation).toBeNull();
});

// --- max_rounds is never a success criterion ---

test('hitting max_rounds without a win yields escalation, never won', () => {
  const state = makeState({
    max_rounds: 3,
    current_round: 3,
    rounds: [makeRound(3, { ab_verdict: { winner: 'bar', margin: 'narrow', single_biggest_gap: 'colors' } })],
  });
  const result = decide(state);
  expect(result.status).not.toBe('won');
  expect(result.status).toBe('exhausted');
  expect(result.escalation.reason).toBe('max-rounds');
});

// --- Cost ceiling ---

test('cost ceiling exceeded escalates', () => {
  const state = makeState({
    cost_ceiling_usd: 5.0,
    cumulative_cost_usd: 5.5,
    current_round: 1,
    rounds: [makeRound(1)],
  });
  const result = decide(state);
  expect(result.status).toBe('exhausted');
  expect(result.escalation.reason).toBe('cost-ceiling');
});

test('cost ceiling of null never escalates on cost', () => {
  const state = makeState({
    cost_ceiling_usd: null,
    cumulative_cost_usd: 999,
    max_rounds: 10,
    current_round: 1,
    rounds: [makeRound(1)],
  });
  const result = decide(state);
  expect(result.escalation).toBeNull();
});

// --- No-improvement circuit breaker ---

test('no-improvement over no_improve_k rounds escalates', () => {
  const state = makeState({
    no_improve_k: 2,
    max_rounds: 10,
    current_round: 2,
    rounds: [
      makeRound(1, { single_biggest_gap: 'colors', scores: { overall_pass: false } }),
      makeRound(2, { single_biggest_gap: 'colors', scores: { overall_pass: false } }),
    ],
  });
  const result = decide(state);
  expect(result.status).toBe('escalated');
  expect(result.escalation.reason).toBe('no-improvement');
});

// --- Distinct-failure detector ---

test('identical consecutive failures escalate instead of retrying a third time', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 2,
    rounds: [
      makeRound(1, { failure_category: 'hit-timeout', files_changed: ['a.js'], test_state: { passed: false, exit_code: 1, output_tail: 'same-tail' } }),
      makeRound(2, { failure_category: 'hit-timeout', files_changed: ['a.js'], test_state: { passed: false, exit_code: 1, output_tail: 'same-tail' } }),
    ],
  });
  const result = decide(state);
  expect(result.status).toBe('escalated');
  expect(result.escalation.reason).toBe('identical-consecutive-failure');
});

// --- Per-category retry policy ---

test('hit-timeout resumes from round state rather than restarting', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [makeRound(1, { failure_category: 'hit-timeout' })],
  });
  const result = decide(state);
  expect(result.status).toBe('continue');
  expect(result.action).toBe('resume');
});

test('api-stall retries the round', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [makeRound(1, { failure_category: 'api-stall' })],
  });
  const result = decide(state);
  expect(result.status).toBe('continue');
  expect(result.action).toBe('retry');
});

test('pane-death retries once then escalates', () => {
  const firstState = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [
      makeRound(1, {
        failure_category: 'pane-death',
        pane_death_marker: 'transient',
        test_state: { passed: false, exit_code: 1, output_tail: 'pane-1' },
      }),
    ],
  });
  const firstResult = decide(firstState);
  expect(firstResult.status).toBe('continue');
  expect(firstResult.action).toBe('retry');

  const secondState = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 2,
    rounds: [
      makeRound(1, {
        failure_category: 'pane-death',
        pane_death_marker: 'transient',
        files_changed: ['a.js'],
        test_state: { passed: false, exit_code: 1, output_tail: 'pane-1' },
      }),
      makeRound(2, {
        failure_category: 'pane-death',
        pane_death_marker: 'transient',
        files_changed: ['b.js'],
        test_state: { passed: false, exit_code: 1, output_tail: 'pane-2' },
      }),
    ],
  });
  const secondResult = decide(secondState);
  expect(secondResult.status).toBe('escalated');
  expect(secondResult.action).toBe('escalate');
  expect(secondResult.escalation.reason).toBe('pane-death');
});

test('ambiguous pane-death (no marker) is treated as deterministic and escalates immediately', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [makeRound(1, { failure_category: 'pane-death' })],
  });
  expect(classifyPaneDeath(state.rounds[0])).toBe('deterministic');
  const result = decide(state);
  expect(result.status).toBe('escalated');
  expect(result.action).toBe('escalate');
  expect(result.escalation.reason).toBe('pane-death');
});

test('launch-death escalates immediately, never retries', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [makeRound(1, { failure_category: 'launch-death' })],
  });
  const result = decide(state);
  expect(result.status).toBe('escalated');
  expect(result.action).toBe('escalate');
  expect(result.escalation.reason).toBe('launch-death');
});

test('blocked verdict escalates immediately, never retries', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [makeRound(1, { failure_category: 'blocked' })],
  });
  const result = decide(state);
  expect(result.status).toBe('escalated');
  expect(result.action).toBe('escalate');
  expect(result.escalation.reason).toBe('blocked');
});

// --- Purity ---

test('decide does not mutate the input state', () => {
  const state = makeState({
    max_rounds: 10,
    no_improve_k: 5,
    current_round: 1,
    rounds: [makeRound(1, { failure_category: 'api-stall' })],
  });
  const snapshot = JSON.parse(JSON.stringify(state));
  decide(state);
  expect(state).toEqual(snapshot);
});
