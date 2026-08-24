// round-state.js — durable round-state store for bin/advisor-loop.
//
// The driver owns round_state.json (lives under the loop's outputDir, which
// survives tab close, unlike workspace/ or the worktree). See
// /Users/awesome/.advisor/runs/1786099942-2a9192/output/advisor-loop-design.md
// section 2 for the full schema and worked example.

const fs = require('fs');
const path = require('path');

const REQUIRED_TOP_FIELDS = [
  'schema_version',
  'run_id',
  'goal',
  'bar',
  'worktree_path',
  'head_sha',
  'test_command',
  'safety_gate_path',
  'max_rounds',
  'no_improve_k',
  'autonomy_level',
  'current_round',
  'status',
  'cumulative_cost_usd',
  'rounds',
];

const REQUIRED_ROUND_FIELDS = [
  'round',
  'builder_sid',
  'builder_status',
  'builder_verdict',
  'artifacts',
  'files_changed',
  'test_state',
  'critic_sid',
  'ab_verdict',
  'single_biggest_gap',
  'failure_category',
  'round_cost_usd',
  'started_at',
  'ended_at',
];

function stateFilePath(outputDir) {
  return path.join(outputDir, 'round_state.json');
}

function writeAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

// Init a new round_state for a loop and write it atomically. `fields` must
// supply all driver-init fields from the schema (schema_version, run_id,
// goal, bar, head_sha, test_command, safety_gate_path, max_rounds,
// no_improve_k, autonomy_level; worktree_path is set at round 1 per the
// schema but may be passed here if already known).
function initRoundState(outputDir, fields) {
  const state = {
    schema_version: fields.schema_version,
    run_id: fields.run_id,
    goal: fields.goal,
    bar: fields.bar,
    worktree_path: fields.worktree_path !== undefined ? fields.worktree_path : null,
    head_sha: fields.head_sha,
    test_command: fields.test_command !== undefined ? fields.test_command : null,
    safety_gate_path: fields.safety_gate_path,
    max_rounds: fields.max_rounds,
    cost_ceiling_usd: fields.cost_ceiling_usd !== undefined ? fields.cost_ceiling_usd : null,
    no_improve_k: fields.no_improve_k,
    autonomy_level: fields.autonomy_level,
    // agent is intentionally NOT in REQUIRED_TOP_FIELDS: round_state.json
    // files written before this field existed have no `agent` key, and a
    // resumed loop must still be able to validate and load them.
    agent: fields.agent !== undefined ? fields.agent : 'coder',
    current_round: 0,
    status: 'running',
    cumulative_cost_usd: 0,
    escalation: null,
    rounds: [],
  };
  fs.mkdirSync(outputDir, { recursive: true });
  writeAtomic(stateFilePath(outputDir), state);
  return state;
}

function readRoundState(outputDir) {
  const raw = fs.readFileSync(stateFilePath(outputDir), 'utf8');
  return JSON.parse(raw);
}

function writeRoundState(outputDir, state) {
  writeAtomic(stateFilePath(outputDir), state);
}

// Validate a round_state object against the schema. Returns
// { valid: bool, errors: string[] }. Rejects missing required top-level
// fields and, for each entry in rounds[], missing required RoundRecord fields.
function validateRoundState(state) {
  const errors = [];
  if (state === null || typeof state !== 'object') {
    return { valid: false, errors: ['round_state must be an object'] };
  }
  for (const field of REQUIRED_TOP_FIELDS) {
    if (!(field in state)) errors.push(`missing required field: ${field}`);
  }
  if (Array.isArray(state.rounds)) {
    state.rounds.forEach((round, i) => {
      for (const field of REQUIRED_ROUND_FIELDS) {
        if (!(field in round)) errors.push(`rounds[${i}] missing required field: ${field}`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// Append a RoundRecord to history and persist atomically.
function appendRound(outputDir, state, roundRecord) {
  state.rounds.push(roundRecord);
  writeAtomic(stateFilePath(outputDir), state);
  return state;
}

// No-improvement circuit-breaker predicate: true if the last K rounds show
// no improvement, i.e. single_biggest_gap is identical across all K entries
// AND none of them passed (scores.overall_pass falsy). Returns false if
// fewer than K rounds exist yet.
function noImprovementInLastK(state, k) {
  const rounds = state.rounds;
  if (!Array.isArray(rounds) || rounds.length < k) return false;
  const lastK = rounds.slice(rounds.length - k);
  const firstGap = lastK[0].single_biggest_gap;
  return lastK.every((r) => {
    const abPassed = r.ab_verdict && r.ab_verdict.winner === 'candidate';
    const scoresPassed = r.scores && r.scores.overall_pass;
    const passed = abPassed || scoresPassed;
    return !passed && r.single_biggest_gap === firstGap;
  });
}

module.exports = {
  stateFilePath,
  initRoundState,
  readRoundState,
  writeRoundState,
  validateRoundState,
  appendRound,
  noImprovementInLastK,
};
