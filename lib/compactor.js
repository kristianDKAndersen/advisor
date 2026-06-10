/**
 * lib/compactor.js — message compaction utilities + PreCompact hook entry point
 *
 * Exports:
 *   compactMessages(messages, { maxTokens, summarize? }) async
 *   repairToolUseResultPairing(messages) sync
 *   summarizeInStages(stages, summarize?) async
 *
 * When invoked directly (require.main === module), acts as a Claude Code
 * PreCompact hook: reads {transcript_path} from stdin JSON, compacts the
 * transcript, and writes the result back to the same file.
 */

const fs = require('fs');

/**
 * Default no-op summarize stub: truncates each message's text content.
 * @param {object[]} messages
 * @returns {Promise<object[]>}
 */
async function defaultSummarize(messages) {
  return messages.map(m => {
    const text = typeof m.content === 'string'
      ? m.content.slice(0, 200)
      : JSON.stringify(m.content).slice(0, 200);
    return { role: m.role, content: text };
  });
}

/**
 * Phase 1: remove extraneous tool_result blocks from assistant turns.
 * Keeps tool_use blocks; strips tool_result from assistant content arrays.
 */
function pruneToolResults(messages) {
  return messages.map(m => {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const filtered = m.content.filter(b => b.type !== 'tool_result');
      return { ...m, content: filtered.length ? filtered : m.content };
    }
    return m;
  });
}

/**
 * Phase 2: trim to a conversation boundary (keep last N user turns when large).
 * Boundary = the first user message we can start from without splitting a
 * tool_use/tool_result pair.
 */
function boundaryTrim(messages, maxTokens) {
  // Rough token estimate: 4 chars ≈ 1 token
  const estimate = msg =>
    Math.ceil(JSON.stringify(msg).length / 4);

  const total = messages.reduce((s, m) => s + estimate(m), 0);
  if (total <= maxTokens) return messages;

  // Walk from the end collecting messages until we exceed budget
  let budget = maxTokens;
  let i = messages.length - 1;
  while (i >= 0 && budget > 0) {
    budget -= estimate(messages[i]);
    i--;
  }
  // i+1 is first included message; make sure we start on a user turn
  let start = i + 1;
  while (start < messages.length && messages[start].role !== 'user') start++;
  const trimmed = messages.slice(start);
  return trimmed.length ? trimmed : messages.slice(-1);
}

/**
 * Phase 3: apply summarizer to produce a condensed representation.
 */
async function summarizePhase(messages, summarize) {
  return summarize(messages);
}

/**
 * Phase 4: sanitize — ensure no empty content arrays, fix role alternation.
 */
function sanitize(messages) {
  return messages
    .filter(m => {
      if (Array.isArray(m.content)) return m.content.length > 0;
      if (typeof m.content === 'string') return m.content.length > 0;
      return true;
    })
    .map(m => {
      // Collapse single-item content arrays of plain text to strings
      if (Array.isArray(m.content) && m.content.length === 1 &&
          m.content[0].type === 'text') {
        return { ...m, content: m.content[0].text };
      }
      return m;
    });
}

/**
 * compactMessages — 4-phase async pipeline.
 *
 * @param {object[]} messages - conversation messages
 * @param {{ maxTokens?: number, summarize?: Function }} opts
 * @returns {Promise<object[]>}
 */
async function compactMessages(messages, opts = {}) {
  const { maxTokens = 8000, summarize = defaultSummarize } = opts;

  // Phase 1: prune tool_results from wrong positions
  let result = pruneToolResults(messages);

  // Phase 2: boundary trim
  result = boundaryTrim(result, maxTokens);

  // Phase 3: summarize
  result = await summarizePhase(result, summarize);

  // Phase 4: sanitize
  result = sanitize(result);

  // Guarantee non-empty
  if (!result.length) {
    result = [{ role: 'user', content: '[context compacted]' }];
  }

  return result;
}

/**
 * repairToolUseResultPairing — sync.
 *
 * Scans messages for tool_use blocks and inserts synthetic tool_result
 * responses for any that have no matching tool_result in subsequent messages.
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
function repairToolUseResultPairing(messages) {
  // Build set of all tool_use_ids that already have a result
  const resultIds = new Set(
    messages.flatMap(m =>
      Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id)
        : []
    )
  );

  const out = [];
  for (const msg of messages) {
    out.push(msg);
    if (Array.isArray(msg.content)) {
      const orphans = msg.content.filter(
        b => b.type === 'tool_use' && !resultIds.has(b.id)
      );
      if (orphans.length) {
        // Insert a synthetic user message with tool_results for each orphan
        const synthetic = {
          role: 'user',
          content: orphans.map(b => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: '[synthetic: no result recorded]',
          })),
        };
        out.push(synthetic);
        orphans.forEach(b => resultIds.add(b.id));
      }
    }
  }
  return out;
}

/**
 * summarizeInStages — async.
 *
 * Applies the summarizer independently to each stage (array of messages).
 * Returns an array of the same length as stages.
 *
 * @param {object[][]} stages - array of message arrays
 * @param {Function} [summarize]
 * @returns {Promise<object[][]>}
 */
async function summarizeInStages(stages, summarize = defaultSummarize) {
  return Promise.all(stages.map(stage => summarize(stage)));
}

// PreCompact hook entry point — mirrors the async-stdin pattern used in
// .claude/hooks/stop-telemetry.js and .claude/hooks/stop-handover.js.
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  const { transcript_path } = event || {};
  if (!transcript_path) process.exit(0);

  let lines;
  try {
    lines = fs.readFileSync(transcript_path, 'utf8').split('\n').filter(Boolean);
  } catch { process.exit(0); }

  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  const repaired = repairToolUseResultPairing(messages);
  const compacted = await compactMessages(repaired);

  const tmp = transcript_path + '.tmp';
  fs.writeFileSync(tmp, compacted.map(m => JSON.stringify(m)).join('\n'));
  fs.renameSync(tmp, transcript_path);
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}

module.exports = { compactMessages, repairToolUseResultPairing, summarizeInStages };
