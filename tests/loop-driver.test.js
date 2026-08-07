const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initRoundState, readRoundState } = require('../lib/round-state');
const { runRound, runLoop } = require('../lib/loop-driver');

function tmpOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-driver-test-'));
}

function baseInit(outputDir, overrides = {}) {
  return initRoundState(outputDir, {
    schema_version: '1',
    run_id: 'test-run',
    goal: 'The widget renders correctly.',
    bar: { type: 'external-reference', ref: '/tmp/reference.png' },
    head_sha: 'deadbeef',
    test_command: 'echo ok',
    safety_gate_path: '/tmp/fake-gate.json',
    max_rounds: 5,
    no_improve_k: 2,
    autonomy_level: 'L2',
    ...overrides,
  });
}

// permissive stub set shared by tests that don't care about a specific seam
function permissiveOptions(outputDir, extra = {}) {
  return {
    outputDir,
    repoRoot: '/tmp/fake-repo',
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'result', verdict: 'partial', paths: ['/wt/a.js'], summary: 'did work' }],
    }),
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'tie', margin: 'none', single_biggest_gap: 'still missing x' } },
    }),
    getOrCreateWorktreeFn: (() => {
      let calls = 0;
      return (repoRoot, opts) => {
        calls++;
        return { path: opts.worktreePath || '/tmp/wt-fixed', created: calls === 1 };
      };
    })(),
    filesChangedFn: () => ['src/a.js'],
    removeWorktreeIfTerminalFn: () => false,
    checkGateFn: () => ({ allowed: true }),
    loadGateConfigFn: () => ({ path_denylist: [], action_allowlist: { worktree_write: true, git_commit: true }, worktree_root: null }),
    getCumulativeCostFn: () => 0.1,
    applyDiffFn: () => {},
    runTestCommandFn: () => ({ passed: false, exit_code: 1, output_tail: 'fail' }),
    randomFn: () => 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. Explicit gate action at every call site.
test('every checkGate invocation carries a non-null action', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const gateCalls = [];
  const opts = permissiveOptions(outputDir, {
    checkGateFn: (cfg, files, action) => {
      gateCalls.push(action);
      return { allowed: true };
    },
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: '' } },
    }),
  });
  await runRound(state, opts);
  expect(gateCalls.length).toBeGreaterThan(0);
  for (const action of gateCalls) {
    expect(action).not.toBeNull();
    expect(action).not.toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// 2. Apply before remove on a won round.
test('apply happens before removeWorktreeIfTerminal on a won round', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const order = [];
  const opts = permissiveOptions(outputDir, {
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: '' } },
    }),
    applyDiffFn: () => { order.push('apply'); },
    removeWorktreeIfTerminalFn: () => { order.push('remove'); return true; },
  });
  const { decision } = await runRound(state, opts);
  expect(decision.action).toBe('apply');
  expect(order).toEqual(['apply', 'remove']);
  expect(state.status).toBe('won');
});

// ---------------------------------------------------------------------------
// 3. Cost from the CLI, not from the envelope.
test('cost is sourced from injected cost function, not runParallel result.meta.tokens', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { cost_ceiling_usd: 5 });
  const opts = permissiveOptions(outputDir, {
    runParallelFn: async () => ({
      workers: [{
        sid: 'builder-1', status: 'result', verdict: 'partial', paths: [],
        summary: 'x', toolCalls: 3, tokenEstimate: 0, // envelope reports zero tokens
      }],
    }),
    getCumulativeCostFn: () => 10, // stubbed CLI cost, far above ceiling once summed
  });
  const { decision, state: finalState } = await runRound(state, opts);
  expect(finalState.cumulative_cost_usd).toBeGreaterThan(5);
  expect(decision.status).toBe('exhausted');
  expect(decision.escalation.reason).toBe('cost-ceiling');
});

// ---------------------------------------------------------------------------
// 4. Feedback composition into the next round's brief.
test('round 2 builder brief contains round 1 single_biggest_gap, files_changed, and test_state', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  const briefsSeen = [];
  const opts = permissiveOptions(outputDir, {
    runParallelFn: async (briefs) => {
      briefsSeen.push(briefs[0]);
      return { workers: [{ sid: `builder-${briefsSeen.length}`, status: 'result', verdict: 'partial', paths: [], summary: 'x' }] };
    },
    filesChangedFn: () => ['src/gap-file.js'],
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'tie', margin: 'none', single_biggest_gap: 'the gap from round one' } },
    }),
  });
  await runRound(state, opts);
  await runRound(state, opts);
  expect(briefsSeen.length).toBe(2);
  expect(briefsSeen[1].task).toContain('the gap from round one');
  expect(briefsSeen[1].task).toContain('src/gap-file.js');
});

// ---------------------------------------------------------------------------
// 5. Critic reads the artifact from disk, not the builder's summary.
test('critic brief points at artifacts and worktree_path, never the builder summary', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  let criticTask = null;
  const opts = permissiveOptions(outputDir, {
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'result', verdict: 'partial', paths: ['/wt/output-artifact.js'], summary: 'SECRET_SUMMARY_TEXT' }],
    }),
    getOrCreateWorktreeFn: () => ({ path: '/tmp/wt-for-critic', created: true }),
    spawnCriticFn: async (brief) => {
      criticTask = brief.task;
      return { sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: { winner: 'tie', margin: 'none', single_biggest_gap: '' } } };
    },
  });
  await runRound(state, opts);
  expect(criticTask).toContain('/wt/output-artifact.js');
  expect(criticTask).toContain('/tmp/wt-for-critic');
  expect(criticTask).not.toContain('SECRET_SUMMARY_TEXT');
});

// ---------------------------------------------------------------------------
// 6. Blind A/B mechanics.
test('blind A/B mapping is persisted and the critic brief never labels a side candidate/bar', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  let criticTask = null;
  const opts = permissiveOptions(outputDir, {
    randomFn: () => 0.9, // deterministic: forces a specific candidate/bar label assignment
    spawnCriticFn: async (brief) => {
      criticTask = brief.task;
      return { sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: { winner: 'tie', margin: 'none', single_biggest_gap: '' } } };
    },
  });
  await runRound(state, opts);
  const persisted = readRoundState(outputDir);
  const mapping = persisted.rounds[0].ab_mapping;
  expect(mapping).toBeDefined();
  expect(['A', 'B']).toContain(mapping.candidate);
  expect(['A', 'B']).toContain(mapping.bar);
  expect(mapping.candidate).not.toBe(mapping.bar);
  expect(criticTask.toLowerCase()).not.toContain('candidate');
  expect(criticTask.toLowerCase()).not.toMatch(/\bbar\b/);
});

// ---------------------------------------------------------------------------
// 7. Objective condition cannot be overridden.
test('critic claiming candidate won does not produce status won when acceptance tests are red', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { bar: { type: 'acceptance-tests', ref: 'npm test' }, test_command: 'npm test' });
  const opts = permissiveOptions(outputDir, {
    randomFn: () => 0, // candidateLabel = 'A'
    runTestCommandFn: () => ({ passed: false, exit_code: 1, output_tail: 'RED: 2 failing' }),
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: '' } }, // critic picks the candidate despite red tests
    }),
  });
  const { decision, state: finalState } = await runRound(state, opts);
  expect(decision.status).not.toBe('won');
  expect(finalState.status).not.toBe('won');
});

// ---------------------------------------------------------------------------
// 8. Autonomy default L2.
test('autonomy_level defaults to L2 when unspecified, and escalations surface a structured record', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 0 }); // trips max-rounds on round 0 (0+1 > 0)
  delete state.autonomy_level;
  const opts = permissiveOptions(outputDir);
  const { state: finalState, decision } = await runRound(state, opts);
  expect(finalState.autonomy_level).toBe('L2');
  expect(decision.action).toBe('escalate');
  expect(finalState.escalation).not.toBeNull();
  expect(typeof finalState.escalation.reason).toBe('string');
});

// ---------------------------------------------------------------------------
// 9. Resume, not restart, on hit-timeout.
test('resume round reuses the existing worktree_path instead of creating a new one', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  const wtCalls = [];
  const opts = permissiveOptions(outputDir, {
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'terminated', verdict: null, paths: [], summary: '' }], // maps to hit-timeout
    }),
    getOrCreateWorktreeFn: (repoRoot, wtOpts) => {
      wtCalls.push(wtOpts.worktreePath || null);
      const p = wtOpts.worktreePath || '/tmp/wt-round0';
      return { path: p, created: !wtOpts.worktreePath };
    },
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: null }, // builder timed out, verdict null -> blocked path is skipped by null verdict check below
    }),
  });
  const round0 = await runRound(state, opts);
  expect(round0.decision.action).toBe('resume');
  expect(wtCalls[0]).toBeNull();

  const round1 = await runRound(state, opts);
  expect(wtCalls[1]).toBe(state.worktree_path);
  expect(wtCalls[1]).not.toBeNull();
});

// ---------------------------------------------------------------------------
// 10. Every round persists before it ends.
test('round_state.json contains round N on disk immediately after round N completes', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  const opts = permissiveOptions(outputDir);
  await runRound(state, opts);
  let persisted = readRoundState(outputDir);
  expect(persisted.rounds.length).toBe(1);
  expect(persisted.rounds[0].round).toBe(0);

  await runRound(state, opts);
  persisted = readRoundState(outputDir);
  expect(persisted.rounds.length).toBe(2);
  expect(persisted.rounds[1].round).toBe(1);
});

// ---------------------------------------------------------------------------
// Integration: runLoop drives multiple rounds over stubs to a terminal state.
test('runLoop drives rounds over stubbed dependencies to a won terminal status', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  let round = 0;
  const opts = permissiveOptions(outputDir, {
    randomFn: () => 0,
    runParallelFn: async () => ({
      workers: [{ sid: `builder-${round}`, status: 'result', verdict: 'partial', paths: [], summary: 'x' }],
    }),
    spawnCriticFn: async () => {
      round++;
      const winner = round >= 2 ? 'A' : 'tie';
      return { sid: `critic-${round}`, outputDir: '/tmp/critic-out', scores: { ab_verdict: { winner, margin: 'clear', single_biggest_gap: round >= 2 ? '' : 'gap' } } };
    },
  });
  const finalState = await runLoop(state, opts);
  expect(finalState.status).toBe('won');
  expect(finalState.rounds.length).toBe(2);
});
