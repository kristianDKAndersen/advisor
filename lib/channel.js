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
const { updateSessionState } = require('./session');

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

// Atomic mkdir-spinlock for seq ID assignment. Uses POSIX-atomic mkdir to
// implement a mutual-exclusion lock around a persistent counter file so
// concurrent writers never collide on seq numbers.
//
// channelDir  — the directory that contains (or will contain) the JSONL file.
// Returns the next seq number (1-based, monotonically increasing).
function acquireSeqLock(channelDir) {
  fs.mkdirSync(channelDir, { recursive: true });
  const lockDir = path.join(channelDir, '.seq.lock');
  const counterFile = path.join(channelDir, 'next_seq');
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when lock is held
      // Lock acquired — read, increment, write, release.
      try {
        let current = 0;
        if (fs.existsSync(counterFile)) {
          const raw = fs.readFileSync(counterFile, 'utf8').trim();
          current = parseInt(raw, 10) || 0;
        }
        const next = current + 1;
        fs.writeFileSync(counterFile, String(next));
        return next;
      } finally {
        fs.rmdirSync(lockDir);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw new Error(`acquireSeqLock: timeout after 5s waiting for lock in ${channelDir}`);
      }
      // 10ms synchronous back-off (no async scheduler available here)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

// Message schema: { type: string, body: string|object, from: string|null, seq: number, ts: number }
// body options: (a) string = legacy free-prose; (b) object = structured envelope
//   { summary: string (≤200 chars), paths: string[], verdict: "complete"|"partial"|"blocked" }
// result messages MAY carry an optional meta object: { tool_calls: number, token_estimate: number }
// meta is advisory — no validation or enforcement is applied.
function append(p, msg) {
  ensureFile(p);
  const seq = acquireSeqLock(path.dirname(p));
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

class Tail {
  constructor() { this._offsets = new Map(); }

  read(filePath) {
    ensureFile(filePath);
    const offset = this._offsets.get(filePath) || 0;
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize <= offset) return [];
      const length = fileSize - offset;
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      const text = buf.slice(0, bytesRead).toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline >= 0) this._offsets.set(filePath, offset + lastNewline + 1);
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (_e) {
          process.stderr.write(`[channel] Tail: skipping malformed line: ${line.slice(0, 120)}\n`);
        }
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

const _tailInstance = new Tail();

async function tail(p, { afterSeq = 0, timeoutMs = 60000, pollMs = 500 } = {}) {
  ensureFile(p);
  const deadline = Date.now() + timeoutMs;
  let msgs = _tailInstance.read(p).filter(m => m.seq > afterSeq);
  if (msgs.length) return msgs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    msgs = _tailInstance.read(p).filter(m => m.seq > afterSeq);
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
    `  bun $ADV/lib/channel.js synthesize \\\n` +
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
    if (typeof Bun !== 'undefined') {
      try { (await import('./vault.js')).writeSynthesisNote(record); } catch {}
    }
    updateSessionState(args.sid, s => {
      const entry = (s.decomposition || []).find(d => d.synthesis_seq == null) || {};
      entry.synthesis_seq = Number(args.seq);
      entry.status = 'complete';
      return { ...s, next_action: args.next || s.next_action };
    });
    process.stdout.write(`synthesis recorded: sid=${sid} seq=${seq} material=${args.material}\n`);
    if (args.verdict === 'blocked' && args.material === 'yes') {
      const agent = (args.agent && args.agent !== true) ? args.agent : '<agent>';
      process.stdout.write(
        '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        'LESSON EXTRACTION REQUIRED — worker delivered a failure verdict\n' +
        `(sid=${sid}, seq=${seq}, verdict=blocked, material=yes)\n` +
        '\n' +
        'A lesson note should be written before closing this session.\n' +
        '\n' +
        'GATE: Only write if this is the 2nd or later blocked verdict for\n' +
        'this task shape. Check session.json decomposition array for prior\n' +
        "entries with status='blocked'. One failure = noise; two = signal.\n" +
        '\n' +
        'To extract the lesson, run the extract-lesson skill:\n' +
        '\n' +
        `  /extract-lesson \\\n` +
        `    --synthesis-log ~/.advisor/runs/${sid}/synthesis.log \\\n` +
        `    --synthesis-seq ${seq} \\\n` +
        `    --agent ${agent}\n` +
        '\n' +
        'The skill writes the lesson to:\n' +
        `  ~/.advisor/vault/lessons/${sid}-${agent}-${seq}.md\n` +
        '\n' +
        'And appends an audit line to:\n' +
        '  ~/.advisor/vault/.cache/lessons.jsonl\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
      );
    }
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
    const msgs = _tailInstance.read(args.file).filter(m => m.seq > afterSeq);
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

module.exports = { append, readAll, readAfter, tail, acquireSeqLock, Tail };
