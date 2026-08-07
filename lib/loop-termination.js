// lib/loop-termination.js
//
// Pure decision function for bin/advisor-loop's round-by-round driver. Given
// the durable round_state (lib/round-state.js schema), decides whether the
// loop should stop, continue, or escalate to a human. No I/O, no spawning,
// no side effects — see advisor-loop-design.md section 5 "Termination and
// bounds" for the full rule set this implements.

const { noImprovementInLastK } = require('./round-state');

const PANE_DEATH_RETRY_LIMIT = 1;

// Seam for a future classifier that inspects worker launch/transcript
// artifacts to tell transient pane-death (tmux/pipe-pane error, missing
// transcript) from deterministic pane-death (SIGKILL/OOM with a live
// transcript). Section 5: "the driver cannot yet distinguish transient from
// deterministic pane-death" — until that classifier exists, ambiguous
// pane-death (no marker, or an unrecognized marker) is treated as
// deterministic, the conservative default. Callers may override via
// options.classifyPaneDeath.
function classifyPaneDeath(round) {
  if (round && round.pane_death_marker === 'transient') return 'transient';
  return 'deterministic';
}

function latestRound(state) {
  const rounds = state.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  return rounds[rounds.length - 1];
}

function wonRound(round) {
  return !!round && !!round.ab_verdict && round.ab_verdict.winner === 'candidate';
}

// "Terminal signal" equality for the distinct-failure detector: no
// files_changed delta, or an identical test_state.output_tail.
function sameTerminalSignal(a, b) {
  const aFiles = Array.isArray(a.files_changed) ? a.files_changed : [];
  const bFiles = Array.isArray(b.files_changed) ? b.files_changed : [];
  const noFilesDelta =
    aFiles.length === bFiles.length && aFiles.every((f, i) => f === bFiles[i]);
  const aTail = a.test_state && a.test_state.output_tail;
  const bTail = b.test_state && b.test_state.output_tail;
  const sameOutputTail = aTail !== undefined && aTail !== null && aTail === bTail;
  return noFilesDelta || sameOutputTail;
}

function distinctFailureTriggered(state) {
  const rounds = state.rounds;
  if (!Array.isArray(rounds) || rounds.length < 2) return false;
  const prev = rounds[rounds.length - 2];
  const curr = rounds[rounds.length - 1];
  if (!curr.failure_category || !prev.failure_category) return false;
  if (curr.failure_category !== prev.failure_category) return false;
  return sameTerminalSignal(prev, curr);
}

function escalation(reason, message) {
  return { reason, message };
}

/**
 * Decide the next driver action after a round has completed.
 *
 * @param {object} state - round_state (lib/round-state.js schema)
 * @param {object} [options]
 * @param {(round: object) => ('transient'|'deterministic')} [options.classifyPaneDeath]
 * @returns {{status: 'won'|'continue'|'exhausted'|'escalated', action: 'apply'|'resume'|'retry'|'escalate'|'continue', escalation: object|null}}
 */
function decide(state, options = {}) {
  const classify = options.classifyPaneDeath || classifyPaneDeath;
  const round = latestRound(state);

  // Primary exit — the critic's blind win. A round count is never a success
  // criterion; this is the only path to status:"won".
  if (wonRound(round)) {
    return { status: 'won', action: 'apply', escalation: null };
  }

  // Safety valves — all ESCALATE, none silently succeed.
  if (state.current_round + 1 > state.max_rounds) {
    return {
      status: 'exhausted',
      action: 'escalate',
      escalation: escalation('max-rounds', 'max_rounds reached without a blind win'),
    };
  }

  if (
    state.cost_ceiling_usd !== null &&
    state.cost_ceiling_usd !== undefined &&
    state.cumulative_cost_usd > state.cost_ceiling_usd
  ) {
    return {
      status: 'exhausted',
      action: 'escalate',
      escalation: escalation('cost-ceiling', 'cumulative_cost_usd exceeded cost_ceiling_usd'),
    };
  }

  if (noImprovementInLastK(state, state.no_improve_k)) {
    return {
      status: 'escalated',
      action: 'escalate',
      escalation: escalation('no-improvement', 'single_biggest_gap unchanged for no_improve_k rounds'),
    };
  }

  if (distinctFailureTriggered(state)) {
    return {
      status: 'escalated',
      action: 'escalate',
      escalation: escalation(
        'identical-consecutive-failure',
        'the last two rounds died the same way with the same terminal signal'
      ),
    };
  }

  // Per-category retry policy — not one uniform rule (census-driven).
  const category = round && round.failure_category;

  if (category === 'hit-timeout') {
    return { status: 'continue', action: 'resume', escalation: null };
  }

  if (category === 'api-stall') {
    return { status: 'continue', action: 'retry', escalation: null };
  }

  if (category === 'pane-death') {
    if (classify(round) === 'transient') {
      const rounds = state.rounds;
      const prev = rounds.length >= 2 ? rounds[rounds.length - 2] : null;
      const alreadyRetried = !!prev && prev.failure_category === 'pane-death';
      if (!alreadyRetried) {
        return { status: 'continue', action: 'retry', escalation: null };
      }
    }
    return {
      status: 'escalated',
      action: 'escalate',
      escalation: escalation('pane-death', 'pane-death exhausted its single retry or was deterministic'),
    };
  }

  if (category === 'launch-death') {
    return {
      status: 'escalated',
      action: 'escalate',
      escalation: escalation('launch-death', 'deterministic launch failure will not launch on identical inputs'),
    };
  }

  if (category === 'blocked') {
    return {
      status: 'escalated',
      action: 'escalate',
      escalation: escalation('blocked', 'worker reported a precondition it cannot satisfy'),
    };
  }

  return { status: 'continue', action: 'continue', escalation: null };
}

module.exports = {
  decide,
  classifyPaneDeath,
  PANE_DEATH_RETRY_LIMIT,
};
