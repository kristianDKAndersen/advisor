#!/usr/bin/env node
// Stop hook: sum token usage from session transcript, append to ~/.advisor/state/token-usage.jsonl.
// Receives session_id and transcript_path via stdin JSON (standard hook protocol).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Override state path with ADVISOR_STATE_DIR for testing (matches bin/advisor-cost).
function stateDir() {
  return process.env.ADVISOR_STATE_DIR ||
    path.join(os.homedir(), '.advisor', 'state');
}

const DEBUG_LOG = path.join(stateDir(), 'stop-hook-debug.jsonl');

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

  debugLog({ ts: new Date().toISOString(), sid: 'pending', phase: 'transcript_loaded', size_bytes: transcriptContent.length, line_count: lines.length, elapsed_ms: Date.now() - t0 });

  const { breakdown, by_model, total_used, counting } = sumUsageFromLines(lines);

  const outDir = stateDir();
  fs.mkdirSync(outDir, { recursive: true });
  debugLog({ ts: new Date().toISOString(), sid, phase: 'done', total_used, elapsed_ms: Date.now() - t0 });
  fs.appendFileSync(
    path.join(outDir, 'token-usage.jsonl'),
    JSON.stringify({ sid, counting, total_used, breakdown, by_model }) + '\n'
  );
}

// Sums usage across transcript lines, deduping by message.id (Claude Code
// repeats the same message.usage on one JSONL line per content block) and
// skipping message.model === "<synthetic>" (non-billable synthetic turns).
// usage.iterations[] (when present) carries sub-calls nested inside this
// turn's usage. Known iteration types seen in real transcripts: "message"
// (the executor's own usage, already counted above — ignored here) and
// "advisor_message" (the advisor-tool model's own tokens — folded in below).
function sumUsageFromLines(lines) {
  const seen = new Set();
  const breakdown = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };
  const by_model = {};
  let sawAdvisorIteration = false;

  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const inner = msg.message;
    if (!inner || inner.role !== 'assistant' || !inner.usage) continue;
    if (inner.model === '<synthetic>') continue;
    if (inner.id) {
      if (seen.has(inner.id)) continue;
      seen.add(inner.id);
    }

    const u = inner.usage;
    const input_tokens = u.input_tokens || 0;
    const output_tokens = u.output_tokens || 0;
    const cache_read_input_tokens = u.cache_read_input_tokens || 0;
    let cache_5m = 0;
    let cache_1h = 0;
    if (u.cache_creation) {
      cache_5m = u.cache_creation.ephemeral_5m_input_tokens || 0;
      cache_1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
    } else {
      cache_5m = u.cache_creation_input_tokens || 0;
    }

    breakdown.input_tokens += input_tokens;
    breakdown.output_tokens += output_tokens;
    breakdown.cache_read_input_tokens += cache_read_input_tokens;
    breakdown.cache_creation_input_tokens += (cache_5m + cache_1h);

    const model = inner.model || 'unknown';
    if (!by_model[model]) {
      by_model[model] = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_5m_input_tokens: 0,
        cache_creation_1h_input_tokens: 0
      };
    }
    by_model[model].input_tokens += input_tokens;
    by_model[model].output_tokens += output_tokens;
    by_model[model].cache_read_input_tokens += cache_read_input_tokens;
    by_model[model].cache_creation_5m_input_tokens += cache_5m;
    by_model[model].cache_creation_1h_input_tokens += cache_1h;

    if (Array.isArray(u.iterations)) {
      for (const it of u.iterations) {
        if (it.type !== 'advisor_message') continue;
        sawAdvisorIteration = true;

        const aInput = it.input_tokens || 0;
        const aOutput = it.output_tokens || 0;
        const aCacheRead = it.cache_read_input_tokens || 0;
        let aCache5m = 0;
        let aCache1h = 0;
        if (it.cache_creation) {
          aCache5m = it.cache_creation.ephemeral_5m_input_tokens || 0;
          aCache1h = it.cache_creation.ephemeral_1h_input_tokens || 0;
        } else {
          aCache5m = it.cache_creation_input_tokens || 0;
        }

        breakdown.input_tokens += aInput;
        breakdown.output_tokens += aOutput;
        breakdown.cache_read_input_tokens += aCacheRead;
        breakdown.cache_creation_input_tokens += (aCache5m + aCache1h);

        const aModel = it.model || 'unknown';
        if (!by_model[aModel]) {
          by_model[aModel] = {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_5m_input_tokens: 0,
            cache_creation_1h_input_tokens: 0
          };
        }
        by_model[aModel].input_tokens += aInput;
        by_model[aModel].output_tokens += aOutput;
        by_model[aModel].cache_read_input_tokens += aCacheRead;
        by_model[aModel].cache_creation_5m_input_tokens += aCache5m;
        by_model[aModel].cache_creation_1h_input_tokens += aCache1h;
      }
    }
  }

  const total_used = breakdown.input_tokens + breakdown.output_tokens +
    breakdown.cache_read_input_tokens + breakdown.cache_creation_input_tokens;

  return { breakdown, by_model, total_used, counting: sawAdvisorIteration ? 'dedupe-v3' : 'dedupe-v2' };
}

main().catch(() => process.exit(0));
