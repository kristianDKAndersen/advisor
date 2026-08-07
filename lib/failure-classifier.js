// lib/failure-classifier.js
//
// Transient-versus-deterministic classifier for finished worker sessions
// (design section 10, open decision 4). lib/loop-termination.js stays pure
// and cannot read disk; this module does the I/O and hands loop-termination
// a plain 'transient'|'deterministic' string through its
// options.classifyPaneDeath seam. See lib/loop-termination.js's
// classifyPaneDeath default and decide()'s pane-death branch for the seam
// this plugs into.
//
// Markers are read from three places under a worker session directory:
//   - <dir>/channel/outbox.jsonl : progress/question/result messages
//   - <dir>/tmux-runner.log      : raw tmux command failures + hard-timeout line
// The wrapper's own synthetic failure result (written by
// lib/channel.js's ensure-result / lib/tmux-runner.js's sealOutbox when a
// worker exits without ever sending a real result) has the shape:
//   "worker exited without result (exit_code=<N|unknown>[, signal=<SIG>]); reason=<R>"
// with body.verdict always 'blocked' and from:'wrapper' regardless of the
// real reason - so that literal verdict must NOT be read as a genuine
// worker-reported 'blocked'. We detect the synthetic marker by its from+text
// shape and route by the embedded reason= field instead.

const fs = require('fs');
const path = require('path');

const TMUX_INFRA_RACE_RE = /Command failed:\s*tmux\s+\S+/;
const TMUX_TIMEOUT_RE = /spawnHeadless timed out after/;
const SYNTHETIC_RESULT_RE = /^worker exited without result/;
const REASON_RE = /reason=([\w-]+)/;
const EXIT_CODE_RE = /exit_code=([^,)]+)/;

function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

function readOutboxMessages(sessionDir) {
  const raw = readFileIfExists(path.join(sessionDir, 'channel', 'outbox.jsonl'));
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // Malformed line: ignored rather than treated as evidence of anything.
    }
  }
  return out;
}

function verdict(category, transient, evidence) {
  return { category, transient, evidence };
}

// Real outbox lines carry body as a JSON-encoded string; tolerate an object
// too (some in-process callers may pass one directly).
function parseBody(rawBody) {
  if (rawBody && typeof rawBody === 'object') return rawBody;
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

/**
 * Classify a finished worker's session directory into a failure category
 * plus a transient/deterministic verdict, with evidence citing the file and
 * marker that justified it. Never returns without evidence.
 *
 * @param {string} sessionDir - path to a worker session dir (~/.advisor/runs/<sid>/)
 * @returns {{category: string, transient: boolean|null, evidence: string}}
 */
function classifySessionDir(sessionDir) {
  const tmuxLog = readFileIfExists(path.join(sessionDir, 'tmux-runner.log'));
  const infraRaceMatch = tmuxLog.match(TMUX_INFRA_RACE_RE);
  const tmuxHitTimeout = TMUX_TIMEOUT_RE.test(tmuxLog);

  const messages = readOutboxMessages(sessionDir);

  let lastResult = null;
  for (const m of messages) {
    if (m && m.type === 'result') lastResult = m;
  }

  if (lastResult) {
    const body = parseBody(lastResult.body);
    const summary = typeof body.summary === 'string' ? body.summary : '';
    const isSynthetic = lastResult.from === 'wrapper' && SYNTHETIC_RESULT_RE.test(summary);

    if (!isSynthetic) {
      // Genuine worker-authored result envelope: the worker itself set this
      // verdict, so (unlike the synthetic wrapper marker) 'blocked' here is
      // a real report, not a placeholder.
      if (body.verdict === 'blocked') {
        return verdict('blocked', null, `channel/outbox.jsonl: genuine result verdict=blocked (from=${lastResult.from})`);
      }
      return verdict('clean-result', null, `channel/outbox.jsonl: genuine result verdict=${body.verdict} (from=${lastResult.from})`);
    }

    const reasonMatch = summary.match(REASON_RE);
    const reason = reasonMatch ? reasonMatch[1] : null;
    const exitCodeMatch = summary.match(EXIT_CODE_RE);
    const exitCode = exitCodeMatch ? exitCodeMatch[1] : 'unknown';

    if (reason === 'timeout' || tmuxHitTimeout) {
      // Transience does not apply the way it does to pane-death: an
      // identical restart hits the same wall clock again, so this is
      // deterministic false on purpose - the caller must RESUME, not retry.
      const ev = reason === 'timeout'
        ? `channel/outbox.jsonl: reason=timeout (exit_code=${exitCode})`
        : `tmux-runner.log: spawnHeadless timed out after ...`;
      return verdict('hit-timeout', false, ev);
    }

    if (reason === 'pane-died' || reason === 'unexpected' || reason === 'stop-hook-but-no-result') {
      if (infraRaceMatch) {
        return verdict('pane-death', true, `tmux-runner.log: ${infraRaceMatch[0]}`);
      }
      // exit_code=143 (SIGTERM) is how the harness kills a timing-out
      // worker - but that case is already routed to hit-timeout above via
      // reason=timeout before we ever reach this branch, so 143 seen here
      // (reason=pane-died/unexpected/stop-hook-but-no-result) is NOT
      // treated as a timeout artifact; it falls through to the exit-code
      // check below like any other code.
      if (exitCode === '137') {
        return verdict('pane-death', false, `channel/outbox.jsonl: exit_code=137 (SIGKILL/OOM, reason=${reason})`);
      }
      return verdict('pane-death', false, `channel/outbox.jsonl: reason=${reason}, exit_code=${exitCode} (ambiguous, defaulting deterministic)`);
    }

    // reason=no-op-success (or any other/unrecognized reason) as the LAST
    // result message means the wrapper's happy-path synthetic write landed
    // and no genuine worker result ever followed - an unusual, ambiguous
    // terminal state. Ambiguous must default to deterministic; we bucket
    // it under pane-death since, unlike launch-death, the outbox is
    // provably non-empty (the worker's pane was alive long enough to reach
    // the wrapper's post-run seal).
    return verdict('pane-death', false, `channel/outbox.jsonl: reason=${reason || 'unrecognized'}, exit_code=${exitCode} (ambiguous, defaulting deterministic)`);
  }

  // No result message at all (of either kind).
  if (tmuxHitTimeout) {
    return verdict('hit-timeout', false, 'tmux-runner.log: spawnHeadless timed out after ... (no outbox result)');
  }

  const hasProgressOrQuestion = messages.some((m) => m && (m.type === 'progress' || m.type === 'question'));
  if (hasProgressOrQuestion) {
    return verdict('api-stall', false, 'channel/outbox.jsonl: progress/question present, no result, no timeout/pane-died markers');
  }

  // launch-death: outbox is empty/missing/no-message - the worker never
  // spoke. Deterministic by default (identical inputs reproduce the same
  // launch failure); transient only when tmux-runner.log shows the process
  // never even got a pane up (an infra race a fresh spawn plausibly clears).
  if (infraRaceMatch) {
    return verdict('launch-death', true, `tmux-runner.log: ${infraRaceMatch[0]}`);
  }
  return verdict('launch-death', false, 'channel/outbox.jsonl: no messages found (empty/missing outbox), defaulting deterministic');
}

/**
 * Adapter for lib/loop-termination.js's options.classifyPaneDeath seam:
 * takes a round record, returns 'transient'|'deterministic'. Reads
 * round.session_dir (the natural field for a future wiring worker to
 * populate); absent session_dir defaults to 'deterministic', the safe
 * default the seam already documents.
 *
 * @param {object} round
 * @returns {'transient'|'deterministic'}
 */
function classifyPaneDeath(round) {
  if (!round || !round.session_dir) return 'deterministic';
  const v = classifySessionDir(round.session_dir);
  return v.transient === true ? 'transient' : 'deterministic';
}

module.exports = {
  classifySessionDir,
  classifyPaneDeath,
};
