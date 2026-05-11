'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Atomically write a "terminal event" payload to disk for post-restart recovery.
 *
 * @param {string} channelDir  Absolute path to the session's channel directory.
 * @param {object} payload     JSON-serializable terminal event.
 * @returns {void}             Best-effort. On I/O error: log to stderr, return without throwing.
 */
function persistTerminal(channelDir, payload) {
  try {
    const tmp = path.join(channelDir, 'terminal.json.tmp');
    const final = path.join(channelDir, 'terminal.json');
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, final);
  } catch (err) {
    console.error('[terminal-persist] write failed:', err.message);
  }
}

/**
 * Load a previously persisted terminal event.
 *
 * @param {string} channelDir
 * @returns {object | null}   Parsed payload, or null if file missing or unreadable.
 */
function loadTerminal(channelDir) {
  try {
    const final = path.join(channelDir, 'terminal.json');
    const raw = fs.readFileSync(final, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

module.exports = { persistTerminal, loadTerminal };
