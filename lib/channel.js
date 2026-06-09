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
const { spawnSync } = require('child_process');
const { updateSessionState, readMeta } = require('./session');
const { persistTerminal } = require('./terminal-persist');

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
// channelDir    — the directory that contains (or will contain) the JSONL file.
// p             — absolute path of the JSONL file to append to.
// partialPayload — message object without seq; seq is assigned inside the lock.
// Returns the completed payload (with seq assigned) after appending it.
function acquireSeqLock(channelDir, p, partialPayload) {
  fs.mkdirSync(channelDir, { recursive: true });
  const lockDir = path.join(channelDir, '.seq.lock');
  const counterFile = path.join(channelDir, 'next_seq');
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when lock is held
      // Lock acquired — read, increment, write counter, append payload, release.
      try {
        let current = 0;
        if (fs.existsSync(counterFile)) {
          const raw = fs.readFileSync(counterFile, 'utf8').trim();
          current = parseInt(raw, 10) || 0;
        }
        const next = current + 1;
        fs.writeFileSync(counterFile, String(next));
        const payload = { ...partialPayload, seq: next };
        fs.appendFileSync(p, JSON.stringify(payload) + '\n');
        return payload;
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
  let payload = msg;
  if (
    payload.type === 'result' &&
    payload.body !== null &&
    typeof payload.body === 'object' &&
    typeof payload.body.summary === 'string' &&
    payload.body.summary.length > 200
  ) {
    payload = { ...payload, body: { ...payload.body, summary: payload.body.summary.slice(0, 197) + '...' } };
  }
  return acquireSeqLock(path.dirname(p), p, { ts: Date.now() / 1000, ...payload });
}

// Atomically check whether any result envelope exists in p; if not, append
// partialPayload as the synthetic result. Returns the appended payload or null.
// The check-and-append runs inside the acquireSeqLock critical section so
// concurrent callers (e.g. launch.sh wrapper + tmux-runner.js) cannot both
// succeed — only the first writer wins; the second sees the result and skips.
function appendSyntheticIfAbsent(p, partialPayload) {
  ensureFile(p);
  const channelDir = path.dirname(p);
  const lockDir = path.join(channelDir, '.seq.lock');
  const counterFile = path.join(channelDir, 'next_seq');
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when lock is held
      try {
        // Read inside the lock so two concurrent callers can't both see "no result".
        const content = fs.readFileSync(p, 'utf8');
        const hasResult = content.split('\n').some(line => {
          if (!line.trim()) return false;
          try { return JSON.parse(line).type === 'result'; } catch (_) { return false; }
        });
        if (hasResult) return null; // already sealed

        let current = 0;
        if (fs.existsSync(counterFile)) {
          const raw = fs.readFileSync(counterFile, 'utf8').trim();
          current = parseInt(raw, 10) || 0;
        }
        const next = current + 1;
        fs.writeFileSync(counterFile, String(next));
        const payload = { ts: Date.now() / 1000, ...partialPayload, seq: next };
        fs.appendFileSync(p, JSON.stringify(payload) + '\n');
        return payload;
      } finally {
        fs.rmdirSync(lockDir);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw new Error(`appendSyntheticIfAbsent: timeout after 5s waiting for lock in ${channelDir}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function readAfter(p, afterSeq = 0) {
  return readAll(p).filter((m) => m.seq > afterSeq);
}

function readAfterFast(p, afterSeq, tail) {
  return tail.read(p).filter(m => m.seq > afterSeq);
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

async function tail(p, { afterSeq = 0, timeoutMs = 60000, pollMs = 500 } = {}) {
  ensureFile(p);
  const localTail = new Tail();
  const deadline = Date.now() + timeoutMs;
  let msgs = localTail.read(p).filter(m => m.seq > afterSeq);
  if (msgs.length) return msgs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    msgs = localTail.read(p).filter(m => m.seq > afterSeq);
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

function runsRoot() {
  if (process.env.ADVISOR_RUNS_ROOT) return process.env.ADVISOR_RUNS_ROOT;
  return path.join(process.env.HOME || process.env.USERPROFILE, '.advisor', 'runs');
}

function synthLogPath(sid) {
  return path.join(runsRoot(), sid, 'synthesis.log');
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
    `    --established '<MAX 200 chars / 2-3 sentences: what concrete thing was produced or confirmed?>' \\\n` +
    `    --gap '<MAX 80 chars / one sentence: what single question remains open? or "none">' \\\n` +
    `    --material <yes|no|partial> \\\n` +
    `    --next '<proceed-to-step-8 | spawn-refinement: <gap> | spawn-evaluator>' \\\n` +
    `    --key-quotes '<1–2 verbatim quotes from the result most important for downstream use; empty string if none>'\n` +
    '\nThis is logged to ~/.advisor/runs/' + sid + '/synthesis.log for cross-session audit.\n' +
    'On success, the worker Terminal tab is closed automatically — no manual close-worker-tab needed.\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  );
}

function printHandoffDirective(msg) {
  const body = msg.body || {};
  const contextLine = body.context != null ? `  context: ${body.context}\n` : '';
  process.stdout.write(
    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'HANDOFF REQUIRED\n' +
    `  receiver_agent: ${body.receiver_agent}\n` +
    `  task: ${body.task}\n` +
    `  goal: ${body.goal}\n` +
    contextLine +
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
    // Write checkpoint file for this synthesis (U20)
    {
      const checkpointsDir = path.join(runsRoot(), sid, 'checkpoints');
      fs.mkdirSync(checkpointsDir, { recursive: true });
      const phase = readSynthesisRecords(sid).length; // count after append = 1-indexed phase
      const nowMs = Date.now();
      const checkpoint = {
        sid,
        seq: Number(seq),
        phase,
        ts: Math.floor(nowMs / 1000),
        ts_iso: new Date(nowMs).toISOString(),
        established: args.established || '',
        gap: args.gap || '',
        material: args.material || '',
        next_action: (args.next && args.next !== true) ? args.next : '',
        key_quotes: (args['key-quotes'] && args['key-quotes'] !== true) ? args['key-quotes'] : '',
      };
      const tmpPath = path.join(checkpointsDir, `phase${phase}-${Math.floor(nowMs / 1000)}.json.tmp`);
      const finalPath = path.join(checkpointsDir, `phase${phase}-${Math.floor(nowMs / 1000)}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2));
      fs.renameSync(tmpPath, finalPath);
    }
    if (typeof Bun !== 'undefined') {
      try { (await import('./vault.js')).writeSynthesisNote(record); } catch {}
    }
    updateSessionState(args.sid, s => {
      const decomposition = s.decomposition || [];
      let entry = decomposition.find(d => d.synthesis_seq == null);
      const isNew = !entry;
      if (isNew) entry = {};
      entry.synthesis_seq = Number(args.seq);
      entry.status = 'complete';
      return {
        ...s,
        decomposition: isNew ? [...decomposition, entry] : decomposition,
        next_action: args.next || s.next_action,
      };
    });
    if (typeof Bun !== 'undefined') {
      try {
        const { createHash } = require('crypto');
        const ep = require('./episodes');
        const meta = readMeta(args.sid) || {};
        const taskStr = (meta.goal || meta.task || args.established || '').slice(0, 200);
        const task_hash = createHash('sha256').update(taskStr).digest('hex');
        ep.writeEpisode({
          sid: args.sid,
          task_hash,
          ts: Date.now() / 1000,
          established: args.established || '',
          gap: args.gap || '',
          key_quotes: (args['key-quotes'] && args['key-quotes'] !== true) ? args['key-quotes'] : '',
        });
      } catch (_) {}
    }
    process.stdout.write(`synthesis recorded: sid=${sid} seq=${seq} material=${args.material}\n`);
    {
      const persistChannelDir = path.join(runsRoot(), sid, 'channel');
      const persistOutboxPath = path.join(persistChannelDir, 'outbox.jsonl');
      const persistAllMsgs = readAll(persistOutboxPath);
      const persistResultMsg = persistAllMsgs
        .filter(m => m.type === 'result' && m.seq <= Number(args.seq))
        .sort((a, b) => b.seq - a.seq)[0];
      if (persistResultMsg) persistTerminal(persistChannelDir, persistResultMsg);
      if (typeof Bun !== 'undefined' && persistResultMsg?.body?.verdict) {
        try {
          const notePath = `synthesis/${sid}-${seq}.md`;
          (await import('./vault.js')).setWorkerVerdict(notePath, persistResultMsg.body.verdict);
        } catch (_) {}
      }
    }
    if (!process.env.ADVISOR_SKIP_TAB_CLOSE) {
      try {
        const closeScript = path.join(__dirname, '..', 'bin', 'close-worker-tab');
        spawnSync(closeScript, [sid], { stdio: 'ignore' });
        process.stdout.write(`closed worker tab for sid=${sid}\n`);
      } catch (e) {
        process.stdout.write(`close-worker-tab skipped: ${e.message}\n`);
      }
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

  if (cmd === 'ensure-result') {
    if (!args.file) {
      console.error('Error: --file is required for ensure-result');
      process.exit(1);
    }
    const exitCode = args['exit-code'] != null && args['exit-code'] !== true
      ? String(args['exit-code'])
      : 'unknown';
    const signal = args.signal && args.signal !== true ? String(args.signal) : null;
    const reason = args.reason && args.reason !== true ? String(args.reason) : null;

    let summary = `worker exited without result (exit_code=${exitCode}`;
    if (signal) summary += `, signal=${signal}`;
    summary += ')';
    if (reason) summary += `; reason=${reason}`;

    const body = { summary, verdict: 'blocked', paths: [] };
    const from = args.from && args.from !== true ? String(args.from) : 'wrapper';

    const appended = appendSyntheticIfAbsent(args.file, { type: 'result', body, from });
    if (appended && !args.quiet) console.log(fmt(appended));
    return;
  }

  if (cmd === 'recv') {
    const afterSeq = parseInt(args.after || '0', 10);
    const msgs = readAll(args.file).filter(m => m.seq > afterSeq);
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
    for (const m of msgs) {
      if (m.type === 'handoff') printHandoffDirective(m);
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
    for (const m of msgs) {
      if (m.type === 'handoff') printHandoffDirective(m);
    }
    return;
  }

  console.error('Usage: channel.js <send|recv|tail|synthesize> --file <path> [...]');
  process.exit(1);
}

if (require.main === module) cli();

module.exports = { append, readAll, readAfter, readAfterFast, tail, acquireSeqLock, Tail, appendSyntheticIfAbsent };
