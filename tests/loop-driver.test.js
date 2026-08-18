const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initRoundState, readRoundState } = require('../lib/round-state');
const { runRound, runLoop } = require('../lib/loop-driver');
const { checkGate } = require('../lib/safety-gate');
const session = require('../lib/session');

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
// UPDATED (failure-classifier wiring): status:'terminated' has no result
// envelope, so failure_category now comes from classifySessionDir, not from
// the driver's coarse status guess. sessionDirFn is stubbed to a fixture
// carrying genuine hit-timeout evidence (tmux-runner.log) so this test keeps
// exercising a real timeout rather than an empty/missing session dir, which
// the classifier would default to 'launch-death' (its conservative default
// for no evidence at all) and flip this test's expected action to escalate.
test('resume round reuses the existing worktree_path instead of creating a new one', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-driver-fixture-'));
  fs.writeFileSync(path.join(fixtureDir, 'tmux-runner.log'), 'spawnHeadless timed out after 1200000ms\n');
  const wtCalls = [];
  const opts = permissiveOptions(outputDir, {
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'terminated', verdict: null, paths: [], summary: '' }], // maps to hit-timeout
    }),
    sessionDirFn: () => fixtureDir,
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
// 11. Worktree path must be persisted to disk before the builder is spawned,
// so a driver death mid-builder doesn't orphan the worktree on resume.
test('worktree_path is persisted to round_state.json on disk before the builder is spawned', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  let sawPersistedBeforeBuilder = false;
  const opts = permissiveOptions(outputDir, {
    getOrCreateWorktreeFn: () => ({ path: '/tmp/wt-pre-persist', created: true }),
    runParallelFn: async () => {
      const onDisk = readRoundState(outputDir);
      sawPersistedBeforeBuilder = onDisk.worktree_path === '/tmp/wt-pre-persist';
      return {
        workers: [{ sid: 'builder-1', status: 'result', verdict: 'partial', paths: [], summary: 'x' }],
      };
    },
  });
  await runRound(state, opts);
  expect(sawPersistedBeforeBuilder).toBe(true);
});

// ---------------------------------------------------------------------------
// 12. End-of-round persistence still happens (regression guard alongside 11).
test('round_state.json still carries the completed round after the early persist', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  const opts = permissiveOptions(outputDir);
  await runRound(state, opts);
  const persisted = readRoundState(outputDir);
  expect(persisted.rounds.length).toBe(1);
  expect(persisted.worktree_path).toBe(state.worktree_path);
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

// ---------------------------------------------------------------------------
// 11. Critic's blind overall_pass cannot survive a requirement-7 downgrade.
test('driver overrides scores.overall_pass to false when the winner is downgraded to bar', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { bar: { type: 'acceptance-tests', ref: 'npm test' }, test_command: 'npm test' });
  const opts = permissiveOptions(outputDir, {
    randomFn: () => 0, // candidateLabel = 'A'
    runTestCommandFn: () => ({ passed: false, exit_code: 1, output_tail: 'RED: 2 failing' }),
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: {
        ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: 'still missing x' },
        overall_pass: true, // critic is blind and confidently wrong
        pattern_consistency: 0.9,
        completeness: 0.8,
        rationale: 'A looked better to me',
      },
    }),
  });
  const { round } = await runRound(state, opts);
  expect(round.ab_verdict.winner).toBe('bar');
  expect(round.scores.overall_pass).toBe(false);
});

// ---------------------------------------------------------------------------
// 12. Three poisoned-but-downgraded rounds escalate instead of spinning to max_rounds.
test('three consecutive downgraded rounds with critic overall_pass:true still trip the no-improvement breaker', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, {
    bar: { type: 'acceptance-tests', ref: 'npm test' },
    test_command: 'npm test',
    max_rounds: 20,
    no_improve_k: 3,
  });
  const opts = permissiveOptions(outputDir, {
    randomFn: () => 0,
    runTestCommandFn: () => ({ passed: false, exit_code: 1, output_tail: 'RED' }),
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: {
        ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: 'same gap every round' },
        overall_pass: true,
      },
    }),
  });
  let decision;
  for (let i = 0; i < 3; i++) {
    ({ decision } = await runRound(state, opts));
  }
  expect(decision.status).toBe('escalated');
  expect(decision.action).toBe('escalate');
  expect(decision.escalation.reason).toBe('no-improvement');
});

// ---------------------------------------------------------------------------
// 13. A tie with no critic-supplied gap still leaves a non-empty single_biggest_gap.
test('a tie verdict with an empty critic gap yields a non-empty single_biggest_gap', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const opts = permissiveOptions(outputDir, {
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'tie', margin: 'none', single_biggest_gap: '' } },
    }),
  });
  const { round } = await runRound(state, opts);
  expect(round.ab_verdict.winner).toBe('tie');
  expect(round.single_biggest_gap).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 14. Non-overall_pass score fields from the critic survive untouched.
test('critic score fields other than overall_pass are left untouched by the driver', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { bar: { type: 'acceptance-tests', ref: 'npm test' }, test_command: 'npm test' });
  const opts = permissiveOptions(outputDir, {
    randomFn: () => 0,
    runTestCommandFn: () => ({ passed: false, exit_code: 1, output_tail: 'RED' }),
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: {
        ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: 'gap' },
        overall_pass: true,
        pattern_consistency: 0.9,
        completeness: 0.8,
        rationale: 'A looked better to me',
      },
    }),
  });
  const { round } = await runRound(state, opts);
  expect(round.scores.pattern_consistency).toBe(0.9);
  expect(round.scores.completeness).toBe(0.8);
  expect(round.scores.rationale).toBe('A looked better to me');
});

// ---------------------------------------------------------------------------
// 15. session_dir wiring (design §10 open-decision-4).
test('roundRecord.session_dir is populated from the worker sid via session.sessionDir', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const opts = permissiveOptions(outputDir, {
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'tie', margin: 'none', single_biggest_gap: '' } },
    }),
  });
  const { round } = await runRound(state, opts);
  expect(round.session_dir).toBe(session.sessionDir('builder-1'));
});

// ---------------------------------------------------------------------------
// 16. decide() actually consults the injected classifyPaneDeath adapter.
test('a stubbed classifyPaneDeath returning transient causes decide() to retry, where the unstubbed wired default (unresolvable session_dir) escalates', async () => {
  const outputDir = tmpOutputDir();
  const stateTransient = baseInit(outputDir, { max_rounds: 10 });
  const transientOpts = permissiveOptions(outputDir, {
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'terminated', verdict: null, paths: [], summary: '' }],
    }),
    classifySessionDirFn: () => ({ category: 'pane-death', transient: false, evidence: 'stub' }),
    classifyPaneDeathFn: () => 'transient',
    spawnCriticFn: async () => ({ sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: null } }),
  });
  const { round: roundTransient, decision: decisionTransient } = await runRound(stateTransient, transientOpts);
  expect(roundTransient.failure_category).toBe('pane-death');
  expect(decisionTransient.action).toBe('retry');

  const outputDir2 = tmpOutputDir();
  const stateDefault = baseInit(outputDir2, { max_rounds: 10 });
  const defaultOpts = permissiveOptions(outputDir2, {
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-nonexistent-xyz', status: 'terminated', verdict: null, paths: [], summary: '' }],
    }),
    classifySessionDirFn: () => ({ category: 'pane-death', transient: false, evidence: 'stub' }),
    spawnCriticFn: async () => ({ sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: null } }),
  });
  const { decision: decisionDefault } = await runRound(stateDefault, defaultOpts);
  expect(decisionDefault.action).toBe('escalate');
});

// ---------------------------------------------------------------------------
// 17. No result envelope: failure_category comes from the classifier, not the driver's guess.
test('a worker with no result envelope gets failure_category hit-timeout from a fixture session dir', async () => {
  const outputDir = tmpOutputDir();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-driver-fixture-'));
  fs.writeFileSync(path.join(fixtureDir, 'tmux-runner.log'), 'spawnHeadless timed out after 1200000ms\n');
  const state = baseInit(outputDir, { max_rounds: 10 });
  const opts = permissiveOptions(outputDir, {
    // driver's own classifyFailure would guess 'launch-death' for status:'error'
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'error', verdict: null, paths: [], summary: '' }],
    }),
    sessionDirFn: () => fixtureDir,
    spawnCriticFn: async () => ({ sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: null } }),
  });
  const { round, decision } = await runRound(state, opts);
  expect(round.session_dir).toBe(fixtureDir);
  expect(round.failure_category).toBe('hit-timeout');
  expect(decision.action).toBe('resume');
});

test('a worker with no result envelope gets failure_category pane-death from a fixture session dir', async () => {
  const outputDir = tmpOutputDir();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-driver-fixture-'));
  fs.mkdirSync(path.join(fixtureDir, 'channel'), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, 'channel', 'outbox.jsonl'),
    JSON.stringify({
      type: 'result',
      from: 'wrapper',
      body: JSON.stringify({ verdict: 'blocked', summary: 'worker exited without result (exit_code=137); reason=pane-died' }),
    }) + '\n'
  );
  const state = baseInit(outputDir, { max_rounds: 10 });
  const opts = permissiveOptions(outputDir, {
    // driver's own classifyFailure would guess 'hit-timeout' for status:'terminated'
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'terminated', verdict: null, paths: [], summary: '' }],
    }),
    sessionDirFn: () => fixtureDir,
    classifyPaneDeathFn: () => 'deterministic',
    spawnCriticFn: async () => ({ sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: null } }),
  });
  const { round, decision } = await runRound(state, opts);
  expect(round.session_dir).toBe(fixtureDir);
  expect(round.failure_category).toBe('pane-death');
  expect(decision.action).toBe('escalate');
});

// ---------------------------------------------------------------------------
// 18. Result envelope: the driver's own derivation is never overridden.
test('a worker with a result envelope keeps the driver-derived failure_category even when the classifier disagrees', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir, { max_rounds: 10 });
  const opts = permissiveOptions(outputDir, {
    runParallelFn: async () => ({
      workers: [{ sid: 'builder-1', status: 'result', verdict: 'blocked', paths: [], summary: 'x' }],
    }),
    classifySessionDirFn: () => ({ category: 'clean-result', transient: null, evidence: 'stub-disagrees' }),
    spawnCriticFn: async () => ({ sid: 'critic-1', outputDir: '/tmp/critic-out', scores: { ab_verdict: null } }),
  });
  const { round, decision } = await runRound(state, opts);
  expect(round.failure_category).toBe('blocked');
  expect(decision.action).toBe('escalate');
  expect(decision.escalation.reason).toBe('blocked');
});

// ---------------------------------------------------------------------------
// 19. The placeholder worktree_root is replaced with the round's real worktree path.
test('a placeholder worktree_root in the loaded gate config is replaced with the round worktree path', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const seenConfigs = [];
  const opts = permissiveOptions(outputDir, {
    loadGateConfigFn: () => ({
      path_denylist: [],
      action_allowlist: { worktree_write: true, git_commit: true },
      worktree_root: 'REPLACE_ME_worktree_root_per_run',
    }),
    checkGateFn: (cfg) => {
      seenConfigs.push(cfg.worktree_root);
      return { allowed: true };
    },
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: '' } },
    }),
  });
  await runRound(state, opts);
  expect(seenConfigs.length).toBeGreaterThan(0);
  for (const root of seenConfigs) {
    expect(root).toBe('/tmp/wt-fixed');
  }
});

// ---------------------------------------------------------------------------
// 20. An operator-specified, non-placeholder worktree_root is preserved.
test('an operator-specified non-placeholder worktree_root is not overridden', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const seenConfigs = [];
  const opts = permissiveOptions(outputDir, {
    loadGateConfigFn: () => ({
      path_denylist: [],
      action_allowlist: { worktree_write: true, git_commit: true },
      worktree_root: '/operator/pinned/root',
    }),
    checkGateFn: (cfg) => {
      seenConfigs.push(cfg.worktree_root);
      return { allowed: true };
    },
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: '' } },
    }),
  });
  await runRound(state, opts);
  expect(seenConfigs.length).toBeGreaterThan(0);
  for (const root of seenConfigs) {
    expect(root).toBe('/operator/pinned/root');
  }
});

// ---------------------------------------------------------------------------
// 21. A real containment check permits a file inside the round's worktree.
test('a file inside the round worktree is permitted by the now-real containment check', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  let capturedConfig = null;
  const opts = permissiveOptions(outputDir, {
    loadGateConfigFn: () => ({
      path_denylist: [],
      action_allowlist: { worktree_write: true, git_commit: true },
      worktree_root: 'REPLACE_ME_worktree_root_per_run',
    }),
    filesChangedFn: () => ['/tmp/wt-fixed/src/a.js'],
    checkGateFn: (cfg, files, action) => {
      capturedConfig = cfg;
      return checkGate(cfg, files, action);
    },
    spawnCriticFn: async () => ({
      sid: 'critic-1',
      outputDir: '/tmp/critic-out',
      scores: { ab_verdict: { winner: 'A', margin: 'clear', single_biggest_gap: '' } },
    }),
  });
  const { decision } = await runRound(state, opts);
  expect(capturedConfig.worktree_root).toBe('/tmp/wt-fixed');
  expect(decision.status).not.toBe('gate_violation');
});

// ---------------------------------------------------------------------------
// 22. A real containment check refuses a path escaping the round's worktree.
test('a path escaping the round worktree is refused with reason outside_worktree', async () => {
  const outputDir = tmpOutputDir();
  const state = baseInit(outputDir);
  const opts = permissiveOptions(outputDir, {
    loadGateConfigFn: () => ({
      path_denylist: [],
      action_allowlist: { worktree_write: true, git_commit: true },
      worktree_root: 'REPLACE_ME_worktree_root_per_run',
    }),
    filesChangedFn: () => ['/etc/passwd'],
    checkGateFn: (cfg, files, action) => checkGate(cfg, files, action),
  });
  const { decision } = await runRound(state, opts);
  expect(decision.status).toBe('gate_violation');
  expect(decision.escalation.detail.reason).toBe('outside_worktree');
  expect(decision.escalation.detail.path).toBe('/etc/passwd');
});
