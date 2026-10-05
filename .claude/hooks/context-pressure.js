#!/usr/bin/env node
// PostToolUse hook: measures the Advisor orchestrator's current context size
// from the last assistant message's usage in the transcript and injects a
// one-time-per-50K-band notice once it crosses ADVISOR_HANDOVER_TOKENS
// (default 200000). Never blocks: always exits 0, silent on any error.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mirrors stop-telemetry.js's ADVISOR_STATE_DIR convention (testable override).
function stateDir() {
  return process.env.ADVISOR_STATE_DIR || path.join(os.homedir(), '.advisor', 'state');
}

const TAIL_BYTES = 256 * 1024;

// Reads only the tail of the transcript (it can be >50MB) and returns the
// usage object of the LAST assistant message found, or null.
function readLastAssistantUsage(transcriptPath) {
  const size = fs.statSync(transcriptPath).size;
  const readSize = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readSize, size - readSize);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (size > readSize) {
    // drop the first (likely partial) line from the tail read
    const nl = text.indexOf('\n');
    if (nl !== -1) text = text.slice(nl + 1);
  }
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const m = entry && entry.message;
    if (m && m.role === 'assistant' && m.usage) return m.usage;
  }
  return null;
}

function usageTotal(u) {
  const input = u.input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  let cacheCreate;
  if (u.cache_creation) {
    cacheCreate = (u.cache_creation.ephemeral_5m_input_tokens || 0) +
      (u.cache_creation.ephemeral_1h_input_tokens || 0);
  } else {
    cacheCreate = u.cache_creation_input_tokens || 0;
  }
  return input + cacheRead + cacheCreate;
}

try {
  if (process.env.ADVISOR_WORKER_HOOKS === '1') process.exit(0);

  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  let event;
  try { event = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const sid = typeof event.session_id === 'string' ? event.session_id : '';
  const transcriptPath = typeof event.transcript_path === 'string' ? event.transcript_path : '';
  if (!sid || !transcriptPath) process.exit(0);

  let usage;
  try { usage = readLastAssistantUsage(transcriptPath); } catch { process.exit(0); }
  if (!usage) process.exit(0);

  const total = usageTotal(usage);
  const threshold = parseInt(process.env.ADVISOR_HANDOVER_TOKENS, 10) || 200000;
  if (total < threshold) process.exit(0);

  const band = Math.floor(total / 50000);
  const stateFile = path.join(stateDir(), 'context-pressure', `${sid}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  if (typeof state.lastBand === 'number' && band <= state.lastBand) process.exit(0);

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ lastBand: band }));

  const approxK = Math.round(total / 1000);
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Context is ~${approxK}K tokens. At the next task boundary (no worker mid-flight without an observe armed), follow 'Context pressure response': write the handover, then /clear.`,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
} catch { /* informational only — never block or crash the tool call */ }
process.exit(0);
