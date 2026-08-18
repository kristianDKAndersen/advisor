// lib/loop-driver.js — the round loop that integrates round-state, safety-gate,
// loop-bar, loop-termination and loop-worktree into bin/advisor-loop's engine.
// See advisor-loop-design.md sections 3-7 for the protocol this implements.
//
// runRound() executes exactly one round: spawn the builder (via runParallel),
// reconstruct a RoundRecord from its terminal state, spawn the critic for a
// blind A/B judgment, append the round to round_state, then consult
// loop-termination's decide() and act on its verdict (apply/resume/retry/
// escalate/continue). runLoop() repeatedly calls runRound() until the loop
// reaches a terminal status.
//
// Every side-effecting step (worktree ops, the cost CLI, applying a diff to
// the main repo, running the test command, spawning the critic) is an
// injectable dependency defaulting to a real implementation, so tests can
// drive N rounds over stubs without spawning workers or touching real git.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const channel = require('./channel');
const { runParallel } = require('./parallel');
const { checkGate, loadGateConfig } = require('./safety-gate');
const { decide } = require('./loop-termination');
const { appendRound, writeRoundState } = require('./round-state');
const { getOrCreateWorktree, filesChanged, removeWorktreeIfTerminal } = require('./loop-worktree');
const session = require('./session');
const { classifySessionDir, classifyPaneDeath } = require('./failure-classifier');

const ADVISOR_ROOT = path.resolve(__dirname, '..');
const SUMMON_BIN = path.join(ADVISOR_ROOT, 'bin', 'summon');
const ADVISOR_COST_BIN = path.join(ADVISOR_ROOT, 'bin', 'advisor-cost');

function tailString(s, n = 2000) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(-n) : s;
}

// ── failure classification ───────────────────────────────────────────────────

// eco: maps runParallel's four terminal statuses onto the census categories
// (hit-timeout/api-stall/pane-death/launch-death/blocked) with a coarse
// heuristic; design §10 open-decision-4 leaves the precise transient-vs-
// deterministic markers unresolved. Upgrade when a launch/transcript-artifact
// classifier lands.
function classifyFailure(worker) {
  if (!worker) return null;
  if (worker.status === 'result') {
    return worker.verdict === 'blocked' ? 'blocked' : null;
  }
  if (worker.status === 'terminated') return 'hit-timeout';
  if (worker.status === 'silent') return 'hit-timeout';
  if (worker.status === 'error') return 'launch-death';
  return null;
}

// ── builder brief (feedback composition, requirement 4) ─────────────────────

function buildBuilderBrief(state, priorRound, worktreePath) {
  const lines = [
    state.task || state.goal,
    `Worktree: ${worktreePath}`,
    'Work ONLY inside this worktree. Do not touch the main repository working tree.',
  ];
  if (state.test_command) lines.push(`Test command: ${state.test_command}`);
  if (priorRound) {
    lines.push('--- Feedback from the previous round ---');
    lines.push(`Single biggest gap: ${priorRound.single_biggest_gap || '(none recorded)'}`);
    lines.push(`Files changed previously: ${(priorRound.files_changed || []).join(', ') || '(none)'}`);
    lines.push(`Prior test state: ${JSON.stringify(priorRound.test_state || {})}`);
  }
  return {
    agent: state.agent || 'coder',
    task: lines.join('\n'),
    goal: state.goal,
  };
}

// ── critic brief (blind A/B, requirements 5 and 6) ───────────────────────────

function describeBar(bar) {
  if (!bar) return 'the comparison target';
  switch (bar.type) {
    case 'external-reference':
      return `the target reference at ${bar.ref}`;
    case 'acceptance-tests':
      return `passing every test in \`${bar.ref}\``;
    case 'prior-round':
      return `the previous round's artifact(s): ${Array.isArray(bar.ref) ? bar.ref.join(', ') : bar.ref}`;
    case 'metric':
      return `the threshold ${bar.ref && bar.ref.name} ${bar.ref && bar.ref.op} ${bar.ref && bar.ref.value}`;
    default:
      return 'the comparison target';
  }
}

// Two judging modes, selected by bar.type (critic-wire-spec.txt v2):
//   predicate  (acceptance-tests, metric)      — one Candidate, no A/B.
//   ab         (external-reference, prior-round) — blind A/B, randomized
//              which-is-which mapping, never revealed to the critic.
// Neither mode ever hands the critic the builder's result/summary or reported
// artifact paths (a self-report like changes.md) — only the worktree path and,
// in ab mode, the bar's own reference path, both read from round_state.
function buildCriticBrief(state, roundRecord, worktreePath, randomFn) {
  const bar = state.bar || {};
  const isPredicate = bar.type === 'acceptance-tests' || bar.type === 'metric';
  const barLine = `Bar: ${JSON.stringify({ type: bar.type, ref: bar.ref, goal: state.goal })}`;

  if (isPredicate) {
    const lines = [
      barLine,
      'Mode: predicate',
      `Candidate: ${JSON.stringify({ path: worktreePath })}`,
    ];
    return { mapping: null, briefText: lines.join('\n') };
  }

  const candidateLabel = randomFn() < 0.5 ? 'A' : 'B';
  const barLabel = candidateLabel === 'A' ? 'B' : 'A';
  const mapping = { candidate: candidateLabel, bar: barLabel };
  const pathFor = { candidate: worktreePath, bar: bar.ref };
  const lines = [
    barLine,
    'Mode: ab',
    `A: ${JSON.stringify({ path: candidateLabel === 'A' ? pathFor.candidate : pathFor.bar })}`,
    `B: ${JSON.stringify({ path: candidateLabel === 'B' ? pathFor.candidate : pathFor.bar })}`,
  ];
  return { mapping, briefText: lines.join('\n') };
}

function mapAbVerdict(criticAb, mapping) {
  if (!criticAb) return null;
  let winner;
  if (criticAb.winner === 'tie') winner = 'tie';
  else if (criticAb.winner === mapping.candidate) winner = 'candidate';
  else if (criticAb.winner === mapping.bar) winner = 'bar';
  else winner = criticAb.winner;
  return {
    winner,
    margin: criticAb.margin != null ? criticAb.margin : null,
    single_biggest_gap: criticAb.single_biggest_gap || '',
  };
}

// ── objective condition (requirement 7) ──────────────────────────────────────

function checkObjectiveCondition(bar, roundRecord) {
  if (!bar) return true;
  if (bar.type === 'acceptance-tests') {
    return !!(roundRecord.test_state && roundRecord.test_state.passed === true);
  }
  if (bar.type === 'metric') {
    // eco: no field carries a measured metric value yet (design §10 leaves the
    // metric-measurement pipeline unspecified); fail closed until roundRecord
    // carries metric_value. Upgrade when the metric-measuring builder contract lands.
    if (roundRecord.metric_value === undefined) return false;
    const { op, value } = bar.ref || {};
    if (op === '<=') return roundRecord.metric_value <= value;
    if (op === '>=') return roundRecord.metric_value >= value;
    if (op === '<') return roundRecord.metric_value < value;
    if (op === '>') return roundRecord.metric_value > value;
    if (op === '==') return roundRecord.metric_value === value;
    return false;
  }
  return true;
}

// ── cost from the CLI, not from the envelope (requirement 3) ─────────────────

function parseCostFromOutput(output) {
  const lines = (output || '').split('\n');
  const totalLine = lines.find((l) => l.trim().startsWith('TOTAL'));
  if (!totalLine) return 0;
  const matches = totalLine.match(/\$[0-9]+(?:\.[0-9]+)?/g);
  if (!matches || matches.length === 0) return 0;
  return parseFloat(matches[matches.length - 1].slice(1));
}

function getCumulativeCostFromCli(sid, execFileSyncFn = childProcess.execFileSync) {
  if (!sid) return 0;
  let out;
  try {
    out = execFileSyncFn(ADVISOR_COST_BIN, [sid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout && e.stdout.toString()) || '';
  }
  return parseCostFromOutput(out);
}

// ── apply-diff (requirement 2 — driver calls this BEFORE removeWorktreeIfTerminal) ──

function applyDiffToRepo(worktreePath, repoRoot, execFileSyncFn = childProcess.execFileSync) {
  execFileSyncFn('git', ['-C', worktreePath, 'add', '-A'], { stdio: 'ignore' });
  const patch = execFileSyncFn('git', ['-C', worktreePath, 'diff', '--cached', 'HEAD'], { encoding: 'utf8' });
  const patchFile = path.join(os.tmpdir(), `advisor-loop-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(patchFile, patch);
  let applied = false;
  try {
    execFileSyncFn('git', ['-C', repoRoot, 'apply', '--whitespace=nowarn', patchFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    applied = true;
  } catch (_) {
    // fall through to file-copy fallback
  }
  if (!applied) {
    const changedFiles = execFileSyncFn('git', ['-C', worktreePath, 'diff', '--cached', '--name-only', 'HEAD'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    for (const rel of changedFiles) {
      const src = path.join(worktreePath, rel);
      const dest = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  try { fs.unlinkSync(patchFile); } catch (_) {}
}

// ── test-command execution ───────────────────────────────────────────────────

function runTestCommand(testCommand, worktreePath, execFileSyncFn = childProcess.execFileSync) {
  if (!testCommand) return { passed: null, exit_code: null, output_tail: '' };
  try {
    const out = execFileSyncFn('bash', ['-lc', testCommand], { cwd: worktreePath, encoding: 'utf8' });
    return { passed: true, exit_code: 0, output_tail: tailString(out) };
  } catch (e) {
    const combined = (e.stdout || '') + (e.stderr || '');
    return { passed: false, exit_code: e.status != null ? e.status : 1, output_tail: tailString(combined) };
  }
}

// ── critic spawn (real default; always stubbed in tests) ────────────────────

function summonAgentReal(args, execFileSyncFn) {
  const stdout = execFileSyncFn(SUMMON_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const braceIdx = stdout.indexOf('{');
  if (braceIdx === -1) throw new Error(`bin/summon produced no JSON. stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(braceIdx));
}

// Terminal for the critic is either a `result` or a `question` — the critic
// contract instructs it to send `question` and halt when its inputs are
// unusable, and that is terminal for the round (never wait out the timeout).
async function pollUntilTerminalReal(outbox, timeoutMs = 30 * 60 * 1000, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let afterSeq = 0;
  while (Date.now() < deadline) {
    const msgs = channel.readAfter(outbox, afterSeq);
    for (const msg of msgs) {
      afterSeq = Math.max(afterSeq, msg.seq);
      if (msg.type === 'result' || msg.type === 'question') return msg;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function defaultSpawnCritic(brief, execFileSyncFn = childProcess.execFileSync) {
  const meta = summonAgentReal(['--agent', brief.agent, '--task', brief.task, '--goal', brief.goal], execFileSyncFn);
  const msg = await pollUntilTerminalReal(meta.outbox);
  if (!msg) throw new Error('loop-critic timed out without delivering a result');
  if (msg.type === 'question') {
    const question = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);
    return { sid: meta.sid, outputDir: meta.outputDir, question };
  }
  const scoresPath = path.join(meta.outputDir, 'scores.json');
  let scores = {};
  if (fs.existsSync(scoresPath)) {
    try { scores = JSON.parse(fs.readFileSync(scoresPath, 'utf8')); } catch (_) {}
  }
  return { sid: meta.sid, outputDir: meta.outputDir, scores };
}

// ── the round ─────────────────────────────────────────────────────────────

async function runRound(state, options = {}) {
  const {
    outputDir,
    repoRoot,
    runParallelFn = runParallel,
    spawnCriticFn = defaultSpawnCritic,
    getOrCreateWorktreeFn = getOrCreateWorktree,
    filesChangedFn = filesChanged,
    removeWorktreeIfTerminalFn = removeWorktreeIfTerminal,
    checkGateFn = checkGate,
    loadGateConfigFn = loadGateConfig,
    getCumulativeCostFn = getCumulativeCostFromCli,
    applyDiffFn = applyDiffToRepo,
    runTestCommandFn = runTestCommand,
    randomFn = Math.random,
    sessionDirFn = session.sessionDir,
    classifySessionDirFn = classifySessionDir,
    classifyPaneDeathFn = classifyPaneDeath,
  } = options;

  if (!state.autonomy_level) state.autonomy_level = 'L2';

  const roundIndex = state.current_round;
  const startedAt = new Date().toISOString();
  const gateConfig = loadGateConfigFn(state.safety_gate_path);
  const priorRound = state.rounds.length ? state.rounds[state.rounds.length - 1] : null;

  // §7: round N+1 reuses round N's worktree; state.worktree_path is null only
  // before round 0 creates it.
  const wt = getOrCreateWorktreeFn(repoRoot, {
    worktreePath: state.worktree_path,
    headSha: state.head_sha,
    runId: state.run_id,
  });
  if (!state.worktree_path) {
    state.worktree_path = wt.path;
    // Persist the worktree path before spawning the builder: if the driver
    // dies mid-round (e.g. the builder hits the round timeout — the exact
    // scenario resumability exists for), a resumed round must find this path
    // on disk rather than creating a fresh worktree from head_sha.
    writeRoundState(outputDir, state);
  }

  // The shipped gate file carries a placeholder worktree_root that no run
  // ever replaces on disk. Fill in the round's real worktree path on the
  // in-memory config only (never write back to state.safety_gate_path).
  // Precedence: an operator-specified, non-placeholder worktree_root wins —
  // if someone pinned a root deliberately, that intent is respected instead
  // of being silently clobbered with the round's worktree path.
  if (!gateConfig.worktree_root || gateConfig.worktree_root === 'REPLACE_ME_worktree_root_per_run') {
    gateConfig.worktree_root = wt.path;
  }

  const builderBrief = buildBuilderBrief(state, priorRound, wt.path);
  const report = await runParallelFn([builderBrief], { outputDir });
  const builderWorker = report.workers[0];

  const filesChangedList = filesChangedFn(wt.path, state.head_sha);

  // §6 checkpoint 1: post-builder, pre-critic. Explicit action, never null.
  const gateCheck1 = checkGateFn(gateConfig, filesChangedList, 'worktree_write');
  if (!gateCheck1.allowed) {
    state.status = 'gate_violation';
    state.escalation = { reason: 'safety-gate', detail: gateCheck1, round: roundIndex };
    writeRoundState(outputDir, state);
    return { state, round: null, decision: { status: 'gate_violation', action: 'escalate', escalation: state.escalation } };
  }

  const testState = runTestCommandFn(state.test_command, wt.path);

  const sessionDirPath = builderWorker.sid ? sessionDirFn(builderWorker.sid) : null;
  const hasResultEnvelope = builderWorker.status === 'result';
  let failureCategory = classifyFailure(builderWorker);
  if (!hasResultEnvelope && sessionDirPath) {
    // No result envelope: the driver cannot itself tell timeout from
    // pane-death from launch-death, so defer to the on-disk classifier.
    failureCategory = classifySessionDirFn(sessionDirPath).category;
  } else if (hasResultEnvelope && failureCategory && sessionDirPath) {
    // The worker spoke for itself; never let the classifier override that,
    // but surface a disagreement rather than silently discarding it.
    const classified = classifySessionDirFn(sessionDirPath);
    if (classified.category !== failureCategory) {
      process.stderr.write(
        `loop-driver: round ${roundIndex} failure_category disagreement — worker-stated '${failureCategory}' vs classifier '${classified.category}' (session_dir=${sessionDirPath}); keeping worker-stated.\n`
      );
    }
  }

  const roundRecord = {
    round: roundIndex,
    builder_sid: builderWorker.sid,
    builder_status: builderWorker.status,
    builder_verdict: builderWorker.verdict != null ? builderWorker.verdict : null,
    artifacts: builderWorker.paths || [],
    files_changed: filesChangedList,
    test_state: testState,
    critic_sid: null,
    ab_verdict: null,
    scores: null,
    ab_mapping: null,
    single_biggest_gap: '',
    failure_category: failureCategory,
    session_dir: sessionDirPath,
    round_cost_usd: 0,
    started_at: startedAt,
    ended_at: null,
  };

  if (roundRecord.builder_verdict !== 'blocked') {
    const isPredicate = state.bar && (state.bar.type === 'acceptance-tests' || state.bar.type === 'metric');
    const { mapping, briefText } = buildCriticBrief(state, roundRecord, wt.path, randomFn);
    const criticResult = await spawnCriticFn({
      agent: 'loop-critic',
      task: briefText,
      goal: `Judgment recorded to scores.json for goal: ${state.goal}`,
    });

    // A critic `question` is terminal for the round (never wait out the
    // 30-minute poll): escalate immediately, carrying the question text.
    if (criticResult.question) {
      roundRecord.critic_sid = criticResult.sid;
      roundRecord.round_cost_usd = getCumulativeCostFn(builderWorker.sid) + getCumulativeCostFn(criticResult.sid);
      state.cumulative_cost_usd = (state.cumulative_cost_usd || 0) + roundRecord.round_cost_usd;
      roundRecord.ended_at = new Date().toISOString();
      appendRound(outputDir, state, roundRecord);
      state.status = 'escalated';
      state.escalation = { reason: 'critic-question', message: criticResult.question, round: roundIndex };
      removeWorktreeIfTerminalFn(repoRoot, wt.path, state.status);
      state.current_round = roundIndex + 1;
      writeRoundState(outputDir, state);
      return { state, round: roundRecord, decision: { status: 'escalated', action: 'escalate', escalation: state.escalation } };
    }

    roundRecord.critic_sid = criticResult.sid;
    const scores = criticResult.scores || {};
    roundRecord.scores = scores;

    if (isPredicate) {
      // Driver-side verdict mapping (keeps lib/loop-termination.js pure):
      // BOTH the critic's overall_pass and the objective condition must hold
      // for a win — neither can override the other.
      roundRecord.ab_mapping = null;
      if (scores.overall_pass === true && checkObjectiveCondition(state.bar, roundRecord)) {
        roundRecord.ab_verdict = { winner: 'candidate', margin: 'clear', single_biggest_gap: '' };
      } else {
        roundRecord.ab_verdict = { winner: 'bar', margin: null, single_biggest_gap: scores.single_biggest_gap || '' };
      }
    } else {
      roundRecord.ab_mapping = mapping;
      roundRecord.ab_verdict = mapAbVerdict(scores.ab_verdict, mapping);
    }
    // The critic's self-reported overall_pass is only an impression in ab
    // mode (blind to the A/B mapping) and can be confidently wrong even in
    // predicate mode (e.g. a passing predicate that still violates a
    // goal clause outside its coverage) — lib/round-state.js's
    // noImprovementInLastK treats scores.overall_pass as a pass signal
    // alongside ab_verdict.winner, so it must track the authoritative,
    // post-downgrade winner in both modes rather than the critic's raw claim.
    roundRecord.scores.overall_pass = !!(roundRecord.ab_verdict && roundRecord.ab_verdict.winner === 'candidate');

    roundRecord.single_biggest_gap = roundRecord.ab_verdict ? roundRecord.ab_verdict.single_biggest_gap : '';
    if (roundRecord.ab_verdict && roundRecord.ab_verdict.winner !== 'candidate' && !roundRecord.single_biggest_gap) {
      roundRecord.single_biggest_gap = '(critic returned no gap)';
    }

    const builderCost = getCumulativeCostFn(builderWorker.sid);
    const criticCost = getCumulativeCostFn(criticResult.sid);
    roundRecord.round_cost_usd = builderCost + criticCost;
  } else {
    roundRecord.round_cost_usd = getCumulativeCostFn(builderWorker.sid);
  }

  state.cumulative_cost_usd = (state.cumulative_cost_usd || 0) + roundRecord.round_cost_usd;
  roundRecord.ended_at = new Date().toISOString();

  // Requirement 10: persist the round to disk before deciding/ending it.
  appendRound(outputDir, state, roundRecord);

  const verdict = decide(state, { classifyPaneDeath: classifyPaneDeathFn });

  if (verdict.action === 'apply') {
    // §6 checkpoint 2: pre-apply. Explicit action, never null.
    const gateCheck2 = checkGateFn(gateConfig, roundRecord.files_changed, 'git_commit');
    if (!gateCheck2.allowed) {
      state.status = 'gate_violation';
      state.escalation = { reason: 'safety-gate', detail: gateCheck2, round: roundIndex };
      writeRoundState(outputDir, state);
      return { state, round: roundRecord, decision: { status: 'gate_violation', action: 'escalate', escalation: state.escalation } };
    }
    // Requirement 2: apply BEFORE remove — removeWorktreeIfTerminal uses
    // `git worktree remove --force`, which discards uncommitted work.
    applyDiffFn(wt.path, repoRoot);
    removeWorktreeIfTerminalFn(repoRoot, wt.path, 'won');
    state.status = 'won';
    state.escalation = null;
  } else if (verdict.action === 'escalate') {
    state.status = verdict.status;
    state.escalation = { ...verdict.escalation, round: roundIndex };
    removeWorktreeIfTerminalFn(repoRoot, wt.path, state.status);
  } else {
    // resume / retry / continue: stay running, worktree persists for reuse.
    state.status = 'running';
    state.escalation = null;
  }

  state.current_round = roundIndex + 1;
  writeRoundState(outputDir, state);

  return { state, round: roundRecord, decision: verdict };
}

async function runLoop(state, options = {}) {
  const cap = (state.max_rounds || 0) + 2;
  let iterations = 0;
  while (state.status === 'running' && iterations < cap) {
    await runRound(state, options);
    iterations++;
  }
  return state;
}

module.exports = {
  runRound,
  runLoop,
  buildBuilderBrief,
  buildCriticBrief,
  describeBar,
  mapAbVerdict,
  classifyFailure,
  checkObjectiveCondition,
  parseCostFromOutput,
  getCumulativeCostFromCli,
  applyDiffToRepo,
  runTestCommand,
  defaultSpawnCritic,
};
