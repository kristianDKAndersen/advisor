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

// ─── Channel JSONL compaction (SmartCrusher-style, pure JS) ────────────────
//
// compactChannelRecords(records) -> string
//   Columnar re-encoding of parsed channel records ({ts,type,from,seq,body}):
//   keys are factored into a header instead of repeating per line, `from` is
//   hoisted when constant, `ts` is delta-encoded against the first record,
//   types get a one-letter legend, exact-duplicate bodies become `~=<seq>`
//   refs, and clusters of similar bodies share a mined prefix/suffix template.
//
// expandChannelCompact(text) -> records
//   Inverse transform. seq/type/from/body (and any extra keys, e.g. result
//   meta) are recovered exactly; ts is quantized to 0.1s — the only lossy
//   field. A `from` equal to the literal string "-" decodes as null.
//
// This is a READ-TIME PRESENTATION transform only: it never writes back to
// the canonical channel files and leaves the wire protocol untouched.

const CHANNEL_KEYS = new Set(['ts', 'type', 'from', 'seq', 'body']);

function escField(s) {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function unescField(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
    } else {
      out += c;
    }
  }
  return out;
}

function commonPrefixLen(strs) {
  let p = strs[0].length;
  for (const s of strs) {
    let i = 0;
    while (i < p && i < s.length && s[i] === strs[0][i]) i++;
    p = i;
  }
  return p;
}

function commonSuffixLen(strs, skip) {
  const tails = strs.map(s => s.slice(skip));
  let p = tails[0].length;
  for (const s of tails) {
    let i = 0;
    while (i < p && i < s.length && s[s.length - 1 - i] === tails[0][tails[0].length - 1 - i]) i++;
    p = i;
  }
  return p;
}

function hasExtras(r) {
  return Object.keys(r).some(k => !CHANNEL_KEYS.has(k));
}

function compactChannelRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return '#cchan v1 n=0';
  const withTs = records.find(r => typeof r.ts === 'number');
  const ts0 = withTs ? withTs.ts : 0;

  // One-letter (shortest unambiguous prefix) legend for the type column.
  const types = [...new Set(records.map(r => String(r.type)))];
  const codeFor = {};
  const used = new Set();
  for (const t of types) {
    let len = 1;
    let code = t.slice(0, len) || 't';
    while (used.has(code) && len < t.length) code = t.slice(0, ++len);
    while (used.has(code)) code += 'x';
    used.add(code);
    codeFor[t] = code;
  }

  // Hoist `from` into the header when constant across all records.
  const fromVals = new Set(records.map(r => (r.from == null ? '-' : String(r.from))));
  const constFrom = fromVals.size === 1 ? [...fromVals][0] : null;

  // Exact-duplicate body dedup + template mining over unique string bodies,
  // bucketed by (type, first 6 chars) so unrelated bodies don't dilute the
  // common prefix/suffix.
  const firstSeqByBody = new Map();
  const buckets = new Map();
  for (const r of records) {
    if (typeof r.body !== 'string' || hasExtras(r)) continue;
    if (firstSeqByBody.has(r.body)) continue;
    firstSeqByBody.set(r.body, r.seq);
    const key = String(r.type) + ' ' + r.body.slice(0, 6);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r.body);
  }
  const templates = [];
  const tplForBody = new Map();
  for (const bodies of buckets.values()) {
    if (bodies.length < 3) continue;
    const pre = commonPrefixLen(bodies);
    const suf = commonSuffixLen(bodies, pre);
    if (pre + suf < 12) continue;
    const id = templates.length + 1;
    templates.push([bodies[0].slice(0, pre), suf ? bodies[0].slice(bodies[0].length - suf) : '']);
    for (const b of bodies) tplForBody.set(b, { id, v: b.slice(pre, b.length - suf) });
  }

  const lines = [`#cchan v1 n=${records.length} ts0=${ts0}`];
  lines.push('#types ' + types.map(t => `${codeFor[t]}=${t}`).join(' '));
  if (constFrom !== null) lines.push(`#const from=${constFrom}`);
  templates.forEach((tpl, i) => lines.push(`#tpl ${i + 1} ${JSON.stringify(tpl)}`));

  for (const r of records) {
    const dt = typeof r.ts === 'number' ? '+' + (r.ts - ts0).toFixed(1) : '?';
    let enc;
    if (hasExtras(r)) {
      const x = {};
      for (const k of Object.keys(r)) if (!CHANNEL_KEYS.has(k)) x[k] = r[k];
      enc = '~x' + JSON.stringify({ x, b: r.body === undefined ? null : r.body });
    } else if (typeof r.body !== 'string') {
      enc = '~o' + JSON.stringify(r.body === undefined ? null : r.body);
    } else if (firstSeqByBody.get(r.body) !== r.seq) {
      enc = '~=' + firstSeqByBody.get(r.body);
    } else if (tplForBody.has(r.body)) {
      const t = tplForBody.get(r.body);
      enc = '~' + t.id + ':' + escField(t.v);
    } else {
      enc = escField(r.body);
      if (enc.startsWith('~')) enc = '~' + enc;
    }
    const cols = [String(r.seq), codeFor[String(r.type)]];
    if (constFrom === null) cols.push(r.from == null ? '-' : escField(String(r.from)));
    cols.push(dt, enc);
    lines.push(cols.join('\t'));
  }
  return lines.join('\n');
}

function expandChannelCompact(text) {
  const lines = String(text).split('\n').filter(l => l.length > 0);
  let ts0 = 0;
  let constFrom; // undefined = per-row `from` column present
  const typeFor = {};
  const templates = {};
  const bodyBySeq = new Map();
  const records = [];

  for (const line of lines) {
    if (line.startsWith('#')) {
      if (line.startsWith('#cchan ')) {
        const m = line.match(/ts0=([-\d.]+)/);
        if (m) ts0 = parseFloat(m[1]);
      } else if (line.startsWith('#types ')) {
        for (const pair of line.slice(7).split(' ')) {
          const eq = pair.indexOf('=');
          if (eq > 0) typeFor[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      } else if (line.startsWith('#const from=')) {
        const v = line.slice(12);
        constFrom = v === '-' ? null : v;
      } else if (line.startsWith('#tpl ')) {
        const m = line.match(/^#tpl (\d+) (.*)$/);
        if (m) templates[m[1]] = JSON.parse(m[2]);
      }
      continue;
    }

    const cols = line.split('\t');
    let i = 0;
    const seq = parseInt(cols[i++], 10);
    const code = cols[i++];
    const type = typeFor[code] !== undefined ? typeFor[code] : code;
    let from;
    if (constFrom === undefined) {
      const f = cols[i++];
      from = f === '-' ? null : unescField(f);
    } else {
      from = constFrom;
    }
    const dt = cols[i++];
    const enc = cols.slice(i).join('\t');

    let body;
    const extras = {};
    if (enc.startsWith('~~')) {
      body = unescField(enc.slice(1));
    } else if (enc.startsWith('~=')) {
      body = bodyBySeq.get(parseInt(enc.slice(2), 10));
    } else if (enc.startsWith('~x')) {
      const o = JSON.parse(enc.slice(2));
      body = o.b;
      Object.assign(extras, o.x);
    } else if (enc.startsWith('~o')) {
      body = JSON.parse(enc.slice(2));
    } else if (enc.startsWith('~')) {
      const m = enc.match(/^~(\d+):([\s\S]*)$/);
      const tpl = m && templates[m[1]];
      body = tpl ? tpl[0] + unescField(m[2]) + tpl[1] : unescField(enc);
    } else {
      body = unescField(enc);
    }
    if (typeof body === 'string') bodyBySeq.set(seq, body);

    const rec = { type, from, seq, body, ...extras };
    if (dt !== '?') rec.ts = +(ts0 + parseFloat(dt)).toFixed(3);
    records.push(rec);
  }
  return records;
}

module.exports = {
  compactMessages,
  repairToolUseResultPairing,
  summarizeInStages,
  compactChannelRecords,
  expandChannelCompact,
};
