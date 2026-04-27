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

// Message schema: { type: string, body: string, from: string|null, seq: number, ts: number }
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
  const body = typeof m.body === 'string' ? m.body : JSON.stringify(m.body);
  const from = m.from ? `(${m.from}) ` : '';
  return `#${m.seq} [${m.type}] ${from}${body}`;
}

async function cli() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

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
    return;
  }

  if (cmd === 'tail') {
    const afterSeq = parseInt(args.after || '0', 10);
    const timeoutMs = parseFloat(args.timeout || '60') * 1000;
    const msgs = await tail(args.file, { afterSeq, timeoutMs });
    if (args.json) console.log(JSON.stringify(msgs));
    else for (const m of msgs) console.log(fmt(m));
    return;
  }

  console.error('Usage: channel.js <send|recv|tail> --file <path> [...]');
  process.exit(1);
}

if (require.main === module) cli();

module.exports = { append, readAll, readAfter, tail };
