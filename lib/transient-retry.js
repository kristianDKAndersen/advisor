'use strict';

const FATAL_PATTERNS = [
  /401/i,
  /403/i,
  /authentication/i,
  /invalid api key/i,
  /context_length/i,
  /context window/i,
  /subscription/i,
];

const TRANSIENT_PATTERNS = [
  /429/i,
  /500/i,
  /502/i,
  /503/i,
  /504/i,
  /529/i,
  /overloaded/i,
  /rate_limit/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /service unavailable/i,
  /at capacity/i,
];

function classifyError({ stderr, exitCode }) {
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(stderr)) return 'fatal';
  }
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(stderr)) return 'transient';
  }
  return 'unknown';
}

function backoffMs(attempt) {
  return 5000 * (3 ** Math.min(attempt, 2));
}

module.exports = { classifyError, backoffMs };
