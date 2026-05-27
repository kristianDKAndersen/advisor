#!/usr/bin/env node
// Stop hook: sum token usage from session transcript, append to ~/.advisor/state/token-usage.jsonl.
// Receives session_id and transcript_path via stdin JSON (standard hook protocol).

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG_LOG = path.join(os.homedir(), '.advisor', 'state', 'stop-hook-debug.jsonl');

function debugLog(entry) {
  if (process.env.ADVISOR_DEBUG !== '1') return;
  try {
    fs.appendFileSync(DEBUG_LOG, JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}

async function main() {
  const t0 = Date.now();
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  const { session_id: sid, transcript_path } = event || {};
  if (!sid || !transcript_path) process.exit(0);

  let transcriptContent;
  let lines;
  try {
    transcriptContent = fs.readFileSync(transcript_path, 'utf8');
    lines = transcriptContent.split('\n').filter(Boolean);
  } catch { process.exit(0); }

  // Bound work: only the tail of the transcript needs to be scanned for the
  // most recent assistant usage record. Prevents O(n) cost as transcripts grow.
  if (lines.length > 1000) lines = lines.slice(-1000);
  debugLog({ ts: new Date().toISOString(), sid: 'pending', phase: 'transcript_loaded', size_bytes: transcriptContent.length, line_count: lines.length, elapsed_ms: Date.now() - t0 });

  const breakdown = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const inner = msg.message;
      if (!inner || inner.role !== 'assistant' || !inner.usage) continue;
      const u = inner.usage;
      breakdown.input_tokens += (u.input_tokens || 0);
      breakdown.output_tokens += (u.output_tokens || 0);
      breakdown.cache_read_input_tokens += (u.cache_read_input_tokens || 0);
      breakdown.cache_creation_input_tokens += (u.cache_creation_input_tokens || 0);
    } catch { /* skip malformed lines */ }
  }

  const total_used = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const outDir = path.join(os.homedir(), '.advisor', 'state');
  fs.mkdirSync(outDir, { recursive: true });
  debugLog({ ts: new Date().toISOString(), sid, phase: 'done', total_used, elapsed_ms: Date.now() - t0 });
  fs.appendFileSync(
    path.join(outDir, 'token-usage.jsonl'),
    JSON.stringify({ sid, total_used, breakdown }) + '\n'
  );
}

main().catch(() => process.exit(0));
