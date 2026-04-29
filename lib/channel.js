#!/usr/bin/env node
// channel.js — append-only JSONL channel between advisor and worker.
//
// Format: one JSON object per line. Auto-assigns monotonic `seq` (line count).
// Both sides (advisor / worker) read with an `--after <seq>` cursor.
//
// Usage as library:
//   const ch = require('./channel');
//   ch.append(path, { type: 'task', body: '...', from: 'advisor' })
//   ch.readAfter(path, lastSeq) -> [msg, ...]
//   await ch.tail(path, { afterSeq, timeoutMs })  // blocks until new, or timeout
//
// Usage as CLI:
//   channel.js send --file <path> --type <t> [--body "<text>"] [--from <name>] [--quiet]
//   channel.js recv --file <path> [--after <seq>] [--json]
//   channel.js tail --file <path> [--after <seq>] [--timeout <secs>] [--json]
//
// --quiet on `send` suppresses the confirmation echo (the caller just wrote
// the message — echoing it back doubles the token cost for worker-side sends).
//
// No dependencies. Polling fallback at 500ms.

const fs = require('fs');
const path = require('path');

function ensureFile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

function readAll(p) {
  ensureFile(p);
  const content = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_e) {
      process.stderr.write(`[channel] skipping malformed line: ${line.slice(0, 120)}\n`);
    }
  }
  return out;
}

// Count non-empty lines without parsing them. Using readAll().length here is
// wrong: readAll skips malformed lines, so a single corrupted append would
// shift the seq counter and silently collide with prior seqs.
//
// Convention (unenforced): exactly one writer per file. Advisor writes inbox,
// worker writes outbox — never the same file. If you need concurrent writers,
// add an OS-level lock or a dedicated counter file.
function nextSeq(p) {
  const content = fs.readFileSync(p, 'utf8');
  let n = 0;
  for (const line of content.split('\n')) if (line.trim()) n++;
  return n + 1;
}

// Message schema: { type: string, body: string|object, from: string|null, seq: number, ts: number }
// body options: (a) string = legacy free-prose; (b) object = structured envelope
//   { summary: string (≤200 chars), paths: string[], verdict: "complete"|"partial"|"blocked" }
// result messages MAY carry an optional meta object: { tool_calls: number, token_estimate: number }
// meta is advisory — no validation or enforcement is applied.
function append(p, msg) {
  ensureFile(p);
  const seq = nextSeq(p);
  const payload = { ts: Date.now() / 1000, seq, ...msg };
  fs.appendFileSync(p, JSON.stringify(payload) + '\n');
  return payload;
}

function readAfter(p, afterSeq = 0) {
  return readAll(p).filter((m) => m.seq > afterSeq);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tail(p, { afterSeq = 0, timeoutMs = 60000, pollMs = 500 } = {}) {
  ensureFile(p);
  const deadline = Date.now() + timeoutMs;
  // immediate check first
  let msgs = readAfter(p, afterSeq);
  if (msgs.length) return msgs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    msgs = readAfter(p, afterSeq);
    if (msgs.length) return msgs;
  }
  return [];
}

// ─── Synthesis helpers ────────────────────────────────────────────────────

function extractSid(filePath) {
  const abs = path.resolve(filePath);
  const channelDir = path.dirname(abs);
  if (path.basename(channelDir) !== 'channel') return null;
  return path.basename(path.dirname(channelDir));
}

function synthLogPath(sid) {
  const home = process.env.HOME || process.env.USERPROFILE;
  return path.join(home, '.advisor', 'runs', sid, 'synthesis.log');
}

function readSynthesisRecords(sid) {
  const p = synthLogPath(sid);
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function hasSynthesisRecord(sid, seq) {
  return readSynthesisRecords(sid).some(r => r.sid === sid && r.seq === seq);
}

function printSynthesisDirective(msg, sid) {
  const seq = msg.seq;
  const from = msg.from || 'unknown';
  const envelopeBlock = typeof msg.body === 'object'
    ? '\nResult envelope received:\n' +
      `  SUMMARY: ${msg.body.summary}\n` +
      `  VERDICT: ${msg.body.verdict}\n` +
      `  PATHS:\n${(msg.body.paths || []).map(p => '    ' + p).join('\n')}\n`
    : '';
  process.stdout.write(
    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    `SYNTHESIS REQUIRED — worker result received (seq=${seq}, agent=${from}, sid=${sid})\n` +
    envelopeBlock +
    '\nBefore any other action (spawning workers, sending guidance, closing tab),\n' +
    'run this command with the four fields filled in:\n' +
    '\n' +
    `  node $ADV/lib/channel.js synthesize \\\n` +
    `    --sid ${sid} \\\n` +
    `    --seq ${seq} \\\n` +
    `    --established '<2-3 sentences: what do the findings establish?>' \\\n` +
    `    --gap '<one sentence: what specific question remains? or "none">' \\\n` +
    `    --material <yes|no|partial> \\\n` +
    `    --next '<proceed-to-step-8 | spawn-refinement: <gap> | spawn-evaluator>' \\\n` +
    `    --key-quotes '<1–2 verbatim quotes from the result most important for downstream use; empty string if none>'\n` +
    '\nThis is logged to ~/.advisor/runs/' + sid + '/synthesis.log for cross-session audit.\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fmt(m) {
  // structured result bodies are objects; string body = legacy free prose
  const body = typeof m.body === 'string' ? m.body : JSON.stringify(m.body);
  const from = m.from ? `(${m.from}) ` : '';
  return `#${m.seq} [${m.type}] ${from}${body}`;
}

async function cli() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (cmd === 'synthesize') {
    const required = ['sid', 'seq', 'established', 'gap', 'material', 'next'];
    const missing = required.filter(f => !args[f] || args[f] === true);
    if (missing.length) {
      process.stderr.write(`Error: missing required fields: ${missing.join(', ')}\n`);
      process.exit(1);
    }
    if (!['yes', 'no', 'partial'].includes(args.material)) {
      process.stderr.write(`Error: --material must be one of yes|no|partial\n`);
      process.exit(1);
    }
    const sid = args.sid;
    const seq = parseInt(args.seq, 10);
    if (hasSynthesisRecord(sid, seq)) {
      process.stderr.write(`synthesis already recorded for sid=${sid} seq=${seq}\n`);
      process.exit(1);
    }
    const p = synthLogPath(sid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const now = Date.now() / 1000;
    const keyQuotes = args['key-quotes'] || ''; // --key-quotes (optional)
    // Synthesis record shape: { seq, sid, ts, ts_iso, established, gap, material, next_action, key_quotes }
    // key_quotes: string (1-2 verbatim quotes from result important for downstream; "" if none)
    const record = {
      seq,
      sid,
      ts: now,
      established: args.established,
      gap: args.gap,
      material: args.material,
      next_action: args.next,
      key_quotes: keyQuotes,
      ts_iso: new Date(now * 1000).toISOString()
    };
    fs.appendFileSync(p, JSON.stringify(record) + '\n');
    process.stdout.write(`synthesis recorded: sid=${sid} seq=${seq} material=${args.material}\n`);
    return;
  }

  if (!args.file) {
    console.error('Error: --file is required');
    process.exit(1);
  }

  if (cmd === 'send') {
    if (!args.type) {
      console.error('Error: --type is required for send');
      process.exit(1);
    }
    const msg = append(args.file, {
      type: args.type,
      body: args.body === true ? '' : (args.body || ''),
      from: args.from === true ? null : (args.from || null)
    });
    if (args.quiet) return;
    if (args.json) console.log(JSON.stringify(msg));
    else console.log(fmt(msg));
    return;
  }

  if (cmd === 'recv') {
    const afterSeq = parseInt(args.after || '0', 10);
    const msgs = readAfter(args.file, afterSeq);
    if (args.json) console.log(JSON.stringify(msgs));
    else for (const m of msgs) console.log(fmt(m));
    const sid = extractSid(args.file);
    if (sid) {
      for (const m of msgs) {
        if (m.type === 'result' && !hasSynthesisRecord(sid, m.seq)) {
          printSynthesisDirective(m, sid);
        }
      }
    }
    return;
  }

  if (cmd === 'tail') {
    const afterSeq = parseInt(args.after || '0', 10);
    const timeoutMs = parseFloat(args.timeout || '60') * 1000;
    const msgs = await tail(args.file, { afterSeq, timeoutMs });
    if (args.json) console.log(JSON.stringify(msgs));
    else for (const m of msgs) console.log(fmt(m));
    const sid = extractSid(args.file);
    if (sid) {
      for (const m of msgs) {
        if (m.type === 'result' && !hasSynthesisRecord(sid, m.seq)) {
          printSynthesisDirective(m, sid);
        }
      }
    }
    return;
  }

  console.error('Usage: channel.js <send|recv|tail|synthesize> --file <path> [...]');
  process.exit(1);
}

if (require.main === module) cli();

module.exports = { append, readAll, readAfter, tail };
