#!/usr/bin/env node
// Stop hook: sum token usage from session transcript, append to ~/.advisor/state/token-usage.jsonl.
// Receives session_id and transcript_path via stdin JSON (standard hook protocol).

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  const { session_id: sid, transcript_path } = event || {};
  if (!sid || !transcript_path) process.exit(0);

  let lines;
  try {
    lines = fs.readFileSync(transcript_path, 'utf8').split('\n').filter(Boolean);
  } catch { process.exit(0); }

  const breakdown = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.role !== 'assistant' || !msg.usage) continue;
      const u = msg.usage;
      breakdown.input_tokens += (u.input_tokens || 0);
      breakdown.output_tokens += (u.output_tokens || 0);
      breakdown.cache_read_input_tokens += (u.cache_read_input_tokens || 0);
      breakdown.cache_creation_input_tokens += (u.cache_creation_input_tokens || 0);
    } catch { /* skip malformed lines */ }
  }

  const total_used = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const outDir = path.join(os.homedir(), '.advisor', 'state');
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(
    path.join(outDir, 'token-usage.jsonl'),
    JSON.stringify({ sid, total_used, breakdown }) + '\n'
  );
}

main().catch(() => process.exit(0));
