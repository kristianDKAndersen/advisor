// lib/mods-smoke.js — pure helpers for bin/advisor-mods-smoke
//
// No claude/tmux spawning here — that lives in the bin so unit tests can
// exercise this module without launching live sessions.

'use strict';

const CHECK_NAMES = ['write-gate', 'canary', 'fleet-waker'];

// Agent names used by fleet-waker's fake summon script. These must match the
// arguments passed to the summon script and the defaults in fakeSummonScript.
const AGENTS = { alpha: 'alpha', beta: 'beta', gamma: 'gamma' };

// Every env var a spawned `claude` child must NOT inherit from this worker,
// so a nested session can't mistake itself for this one (see fleet-waker
// pane-death incident). HOME/PATH/USER/auth vars are kept.
const ENV_SCRUB_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'TMUX',
  'TMUX_PANE',
  'INBOX',
  'OUTBOX',
  'ADVISOR_SID',
  'ADVISOR_AGENT',
  'OUTPUT_DIR',
  'REPO',
  'ADV',
];

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { help: false, only: [], model: 'haiku', keep: false, json: false, timeoutScale: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--only') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--only requires a value');
      if (!CHECK_NAMES.includes(v)) {
        throw new UsageError(`--only must be one of: ${CHECK_NAMES.join(', ')} (got "${v}")`);
      }
      out.only.push(v);
    } else if (a === '--model') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--model requires a value');
      out.model = v;
    } else if (a === '--keep') {
      out.keep = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--timeout-scale') {
      const v = argv[++i];
      if (v === undefined || Number.isNaN(Number(v)) || Number(v) <= 0) {
        throw new UsageError('--timeout-scale requires a positive numeric value');
      }
      out.timeoutScale = Number(v);
    } else {
      throw new UsageError(`Unknown argument: ${a}`);
    }
  }
  if (out.only.length === 0) out.only = CHECK_NAMES.slice();
  // De-dupe while preserving first-seen order (repeatable --only flag).
  out.only = out.only.filter((v, i) => out.only.indexOf(v) === i);
  return out;
}

function usage() {
  return `advisor-mods-smoke — live-test all advisor mods in throwaway Claude Code sessions

Live-runs each mod (write-gate, canary, fleet-waker) in a disposable
Claude Code session / tmux pane and prints PASS/FAIL per check, so
"did we break anything" is one command instead of hand-run tests.

Usage:
  advisor-mods-smoke [--only write-gate|canary|fleet-waker ...] [--model <name>]
                      [--keep] [--json] [--timeout-scale <n>]

Flags:
  --only <check>        Run only this check (repeatable). Default: all three.
  --model <name>        Model for spawned sessions (default: haiku)
  --keep                Keep temp dirs/tmux artifacts; print their paths
  --json                Emit machine-readable results
  --timeout-scale <n>   Multiply all internal poll timeouts by n (default: 1)

Exit codes:
  0  all checks passed
  1  at least one check failed
  2  usage error
  4  missing prerequisite (claude or tmux not on PATH)
`;
}

// Splits raw --output-format stream-json output into parsed event objects,
// skipping any non-JSON line (partial lines, CLI chatter).
function parseStreamJson(raw) {
  const events = [];
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // not a JSON line — skip
    }
  }
  return events;
}

// Finds the session id from a stream-json event list (init event, or any
// event carrying session_id as a fallback).
function extractSessionId(events) {
  for (const ev of events) {
    if (ev && ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      return ev.session_id;
    }
  }
  for (const ev of events) {
    if (ev && ev.session_id) return ev.session_id;
  }
  return null;
}

function streamContainsText(raw, substr) {
  return String(raw || '').includes(substr);
}

function countOccurrences(text, substr) {
  if (!substr) return 0;
  const s = String(text || '');
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = s.indexOf(substr, idx);
    if (idx === -1) break;
    count++;
    idx += substr.length;
  }
  return count;
}

// Bash source for the fake `summon` script fleet-waker's live check points
// ADVISOR_RUNS_ROOT at. Creates a throwaway run dir with meta.json + one
// progress line in channel/outbox.jsonl, mirroring a real summon's shape.
function fakeSummonScript(runsRoot) {
  return `#!/usr/bin/env bash
set -euo pipefail
agent="\${1:-alpha}"
epoch=$(date +%s)
hex=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \\n')
sid="\${epoch}-\${hex}"
dir="${runsRoot}/\${sid}"
mkdir -p "\${dir}/channel"
cat > "\${dir}/meta.json" <<EOF
{"sid":"\${sid}","agent":"\${agent}"}
EOF
echo '{"ts":'"$(date +%s)"',"type":"progress","body":"started","seq":1,"sid":"'"\${sid}"'"}' > "\${dir}/channel/outbox.jsonl"
echo ok
`;
}

// Builds a single backdated result-line (JSON string, one JSONL record) to
// append to a fake run's outbox, as fleet-waker's live check requires.
function buildResultLine({ seq, sid, ts, summary, verdict }) {
  return JSON.stringify({
    ts,
    type: 'result',
    body: JSON.stringify({ summary, verdict }),
    seq,
    sid,
  });
}

// Maps a spawnSync() result to a human-readable timeout reason, or null if
// the process did not time out. Node sets .signal (default SIGTERM) when the
// `timeout` option fires, and may also surface an ETIMEDOUT error.
function timeoutReason(result, timeoutMs) {
  if (!result) return null;
  const timedOut = (result.error && result.error.code === 'ETIMEDOUT') || !!result.signal;
  if (!timedOut) return null;
  return `timed out after ${Math.round(timeoutMs / 1000)}s`;
}

// Pure decision for the fleet-waker send-and-verify loop: the Enter keypress
// needs a retry when the input box still shows the literal text we sent
// (i.e. it was never submitted). Pass the pane capture taken *after* the
// Enter keypress.
function needsEnterRetry(paneTextAfterEnter, sentText) {
  return String(paneTextAfterEnter || '').includes(sentText);
}

// Reduces per-check results to the process exit code (0 all pass, 1 any fail).
function computeExitCode(results) {
  return results.every((r) => r.ok) ? 0 : 1;
}

// Builds the tmux pane argv for launching `claude` with scrubbed env, as
// discrete argv elements (never a shell string, never the inherited env) so
// the long-lived tmux SERVER's env can't leak back in. The env-name recorder
// (`sh -c 'env | cut ... > paneEnvFile; exec "$@"'`) must run AFTER `env -u`
// has scrubbed the vars, or paneEnvFile captures the unscrubbed env and the
// leak check can never fail. Shape:
//   ['env', '-u', SCRUB1, '-u', SCRUB2, ..., 'K=V', ...,
//    'sh', '-c', 'env | cut -d= -f1 | sort > <paneEnvFile>; exec "$@"', 'sh',
//    'claude', ...claudeArgs]
function buildPaneCommand(scrubVars, extraEnv, claudeArgs, paneEnvFile) {
  const argv = ['env'];
  for (const v of scrubVars) argv.push('-u', v);
  for (const [k, v] of Object.entries(extraEnv || {})) argv.push(`${k}=${v}`);
  argv.push('sh', '-c', `env | cut -d= -f1 | sort > ${JSON.stringify(paneEnvFile)}; exec "$@"`, 'sh');
  argv.push('claude', ...claudeArgs);
  return argv;
}

// Pure parse of the folder-trust dialog's highlighted option from a pane
// capture. Returns 'absent' when the dialog isn't shown at all.
function trustSelectionState(paneText) {
  const text = String(paneText || '');
  if (!/trust this folder/i.test(text)) return 'absent';
  if (/❯\s*Yes, I trust this folder/.test(text)) return 'yes';
  if (/❯\s*No, exit/.test(text)) return 'no';
  return 'absent';
}

// Pure check for "Claude Code has finished starting up and is ready to type
// into": the trust dialog is gone, and an empty `❯ ` prompt row sits between
// two horizontal box-drawing rule lines (this build's footer never renders
// the "? for shortcuts" hint the older check waited on).
function isInputReady(paneText) {
  const text = String(paneText || '');
  if (trustSelectionState(text) !== 'absent') return false;
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const isRule = (l) => /^─+$/.test(l.trim());
  const isPromptRow = (l) => /^❯\s*$/.test(l.trim());
  for (let i = 1; i < lines.length - 1; i++) {
    if (isPromptRow(lines[i]) && isRule(lines[i - 1]) && isRule(lines[i + 1])) return true;
  }
  return false;
}

// Pure scrub-leak detector: given the env *names* actually present in the
// spawned pane (one per line, as `env | cut -d= -f1` produces) and the list
// of vars that should have been scrubbed, returns the names that leaked
// through (empty array = clean).
function detectScrubLeak(paneEnvNames, scrubVars) {
  const present = new Set(paneEnvNames);
  return scrubVars.filter((v) => present.has(v));
}

// Last N non-blank, right-trimmed lines of text (used to shrink a full pane
// capture down to FAIL evidence).
function lastNonBlankLines(text, n) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

// Formats FAIL evidence from a full pane capture: last 20 non-blank lines,
// or an explicit "pane empty" marker plus pane_dead status if the capture
// was blank (session likely exited before/without emitting anything).
function formatPaneEvidence(paneText, listPanesOutput) {
  const lines = lastNonBlankLines(paneText, 20);
  if (lines.length === 0) {
    return [
      '(pane empty - session may have exited)',
      `pane_dead status: ${String(listPanesOutput || '').trim() || '(tmux list-panes returned nothing)'}`,
    ];
  }
  return lines;
}

// Finds the fleet band line for a given (short sid, agent) pair in a pane
// capture. Band format: "<6 hex> <agent> <Nm>[ <eventType>][ waiting grace]"
// (e.g. "e9b957 fake-alpha 0m" or "7793f3 fake-alpha 1m progress"). The
// event-type token is matched loosely (any non-space word), since its exact
// value isn't part of the contract. Returns the matched line (trimmed) or
// null if no line matches.
function findBandLine(paneText, shortSid, agent) {
  const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escape(shortSid)}\\s+${escape(agent)}\\s+\\d+m\\b`);
  for (const line of String(paneText || '').split('\n')) {
    if (re.test(line)) return line.replace(/\s+$/, '').replace(/^\s+/, '');
  }
  return null;
}

// Counts, per sid, how many "sid=<sid>" tokens appear in a pane capture
// (the fleet-waker wake prompt renders one "- sid=X agent=Y type=Z ..."
// line per woken worker). Used to assert a given sid woke exactly once
// instead of counting raw "Prompt from the fleet-waker" headers.
function countWakesBySid(paneText) {
  const counts = {};
  const re = /\bsid=(\S+)/g;
  const text = String(paneText || '');
  let m;
  while ((m = re.exec(text))) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

module.exports = {
  CHECK_NAMES,
  ENV_SCRUB_VARS,
  AGENTS,
  UsageError,
  parseArgs,
  usage,
  parseStreamJson,
  extractSessionId,
  streamContainsText,
  countOccurrences,
  fakeSummonScript,
  buildResultLine,
  timeoutReason,
  needsEnterRetry,
  computeExitCode,
  buildPaneCommand,
  trustSelectionState,
  isInputReady,
  detectScrubLeak,
  lastNonBlankLines,
  formatPaneEvidence,
  findBandLine,
  countWakesBySid,
};
