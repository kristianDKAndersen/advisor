'use strict';

// Backend selection for worker panes. The env gate is read only at spawn time.
// Teardown reads the persistent runs/<sid>/backend marker first, then runner.json
// (a clean exit deletes runner.json, not the marker). Observe reads runner.json: it needs pane_id.

const fs = require('fs');
const path = require('path');

function isHerdrMode(env = process.env) {
  return env.ADVISOR_HERDR === '1' && env.HERDR_ENV === '1';
}

function readRunnerBackend(runDir) {
  try {
    if (fs.readFileSync(path.join(runDir, 'backend'), 'utf8').trim() === 'herdr') return 'herdr';
  } catch (_) { /* no marker: fall through to runner.json */ }
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(runDir, 'runner.json'), 'utf8'));
    return rec && rec.backend === 'herdr' ? 'herdr' : 'tmux';
  } catch (_) {
    return 'tmux';
  }
}

function resolveSocketPath(env = process.env) {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const err = new Error('HERDR_SOCKET_PATH is not set');
  err.code = 'HERDR_NO_SOCKET';
  throw err;
}

// The only place the herdr binary name is chosen; callers spawn the result.
function resolveHerdrBin(env = process.env) {
  return env.HERDR_BIN_PATH ? env.HERDR_BIN_PATH : 'herdr';
}

module.exports = { isHerdrMode, readRunnerBackend, resolveSocketPath, resolveHerdrBin };
