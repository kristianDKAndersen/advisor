// telemetry-backfill.js — shared engine for accruing worker-session token
// telemetry after the fact.
//
// Root cause: worker sessions execute their whole task as ONE agent turn and
// then kill their own tmux pane via close-tab (or the advisor's synthesize
// call auto-closes it) BEFORE the turn ends, so the Stop event never fires
// inside a worker session and .claude/hooks/stop-telemetry.js never runs
// there. This module locates the worker's Claude Code transcript from
// session-map.jsonl + the run's workspace path, then invokes
// stop-telemetry.js as the single computation/summing engine so that logic
// is not duplicated here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Override state path with ADVISOR_STATE_DIR for testing (matches bin/advisor-cost).
function stateDir() {
  return process.env.ADVISOR_STATE_DIR || path.join(os.homedir(), '.advisor', 'state');
}

// Override for testing so fixtures never touch the real ~/.claude/projects.
function claudeProjectsDir() {
  return process.env.ADVISOR_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

// Claude Code encodes a project's working directory into its transcript
// directory name by replacing '/' and '.' with '-'. Verified against real
// dirs in ~/.claude/projects (e.g. "/Users/x/.advisor/runs/<sid>/workspace"
// -> "-Users-x--advisor-runs-<sid>-workspace").
function encodeProjectDir(workspacePath) {
  return workspacePath.replace(/[/.]/g, '-');
}

// Returns every {run_sid, claude_uuid, ...} line in session-map.jsonl, in file order.
function readSessionMapEntries(stDir) {
  const p = path.join(stDir, 'session-map.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.run_sid && e.claude_uuid) entries.push(e);
    } catch { /* skip malformed lines */ }
  }
  return entries;
}

// Resolves a run_sid to its claude_uuid; the LAST matching line wins (a sid
// could in principle appear more than once across a restarted worker).
function resolveClaudeUuid(sid, stDir) {
  const entries = readSessionMapEntries(stDir || stateDir());
  let found = null;
  for (const e of entries) if (e.run_sid === sid) found = e.claude_uuid;
  return found;
}

function transcriptPathFor(workspacePath, claudeUuid) {
  return path.join(claudeProjectsDir(), encodeProjectDir(workspacePath), `${claudeUuid}.jsonl`);
}

// Invokes .claude/hooks/stop-telemetry.js with a synthesized stdin payload,
// exactly as Claude Code's own Stop hook dispatch would. Reused as the single
// computation engine so summing logic lives in one place. ADVISOR_STATE_DIR
// is passed through explicitly (rather than left to ambient process.env)
// because stop-telemetry.js reads it to decide where to append the row, and
// callers may resolve a stDir different from their own process.env value.
function runStopTelemetryHook(claudeUuid, transcriptPath, stDir) {
  const hookScript = path.join(__dirname, '..', '.claude', 'hooks', 'stop-telemetry.js');
  const payload = JSON.stringify({ session_id: claudeUuid, transcript_path: transcriptPath });
  execFileSync(process.execPath, [hookScript], {
    input: payload,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, ADVISOR_STATE_DIR: stDir || stateDir() },
  });
}

// Best-effort: accrues a token-usage row for one run sid given its workspace
// path. Missing map entry, missing workspace, or missing transcript is
// non-fatal — returns a result object instead of throwing so callers (the
// synthesize path, the backfill CLI) can log without aborting.
function accrueForSid(sid, workspacePath, stDir) {
  const sd = stDir || stateDir();
  const claudeUuid = resolveClaudeUuid(sid, sd);
  if (!claudeUuid) return { ok: false, reason: 'no session-map entry' };
  if (!workspacePath) return { ok: false, reason: 'no workspace path in meta' };
  const transcriptPath = transcriptPathFor(workspacePath, claudeUuid);
  if (!fs.existsSync(transcriptPath)) {
    return { ok: false, reason: `transcript not found: ${transcriptPath}`, claudeUuid };
  }
  runStopTelemetryHook(claudeUuid, transcriptPath, sd);
  return { ok: true, claudeUuid, transcriptPath };
}

// Returns the set of claude_uuids already present in token-usage.jsonl.
function alreadyRecordedUuids(stDir) {
  const sd = stDir || stateDir();
  const p = path.join(sd, 'token-usage.jsonl');
  const set = new Set();
  if (!fs.existsSync(p)) return set;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.sid) set.add(e.sid);
    } catch { /* skip malformed lines */ }
  }
  return set;
}

module.exports = {
  stateDir,
  claudeProjectsDir,
  encodeProjectDir,
  readSessionMapEntries,
  resolveClaudeUuid,
  transcriptPathFor,
  runStopTelemetryHook,
  accrueForSid,
  alreadyRecordedUuids,
};
