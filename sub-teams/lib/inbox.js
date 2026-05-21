#!/usr/bin/env bun
import { mkdirSync, readFileSync, appendFileSync, existsSync, watch } from 'fs';
import { join } from 'path';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        result[key] = true;
      } else {
        result[key] = next;
        i++;
      }
    }
  }
  return result;
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

function readMessagesFiltered(inboxFile, afterSeq) {
  if (!existsSync(inboxFile)) return [];
  const content = readFileSync(inboxFile, 'utf8');
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.seq > afterSeq) out.push(msg);
    } catch (_) {
      // skip malformed line; partial appends are unlikely (<PIPE_BUF) but defensive
    }
  }
  return out;
}

if (cmd === 'send') {
  const { 'run-dir': runDir, to, type, 'task-id': taskId, body, from } = args;
  if (!runDir || !to || !type || body === undefined) {
    console.log(JSON.stringify({ error: '--run-dir, --to, --type, and --body are required' }));
    process.exit(1);
  }
  try {
    const inboxDir = join(runDir, 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const inboxFile = join(inboxDir, `${to}.jsonl`);

    let seq = 1;
    if (existsSync(inboxFile)) {
      const content = readFileSync(inboxFile, 'utf8');
      seq = content.split('\n').filter(l => l.trim()).length + 1;
    }

    const msg = {
      seq,
      type,
      from: from || null,
      to,
      task_id: taskId || null,
      body,
      ts: Math.floor(Date.now() / 1000),
    };
    appendFileSync(inboxFile, JSON.stringify(msg) + '\n');
    console.log(JSON.stringify({ ok: true, seq }));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
} else if (cmd === 'recv') {
  const { 'run-dir': runDir, role, after } = args;
  if (!runDir || !role || after === undefined) {
    console.log(JSON.stringify({ error: '--run-dir, --role, and --after are required' }));
    process.exit(1);
  }
  const wait = args.wait === true || args.wait === 'true';
  const timeoutSecs = args.timeout != null && args.timeout !== true
    ? parseFloat(args.timeout)
    : 300;
  const afterSeq = parseInt(after, 10);

  const inboxDir = join(runDir, 'inbox');
  const inboxFile = join(inboxDir, `${role}.jsonl`);

  try {
    // Ensure inbox dir exists so fs.watch doesn't ENOENT on a fresh run.
    mkdirSync(inboxDir, { recursive: true });

    let messages = readMessagesFiltered(inboxFile, afterSeq);

    if (!wait || messages.length > 0) {
      console.log(JSON.stringify({ messages }));
      process.exit(0);
    }

    // Wait path: set up watcher BEFORE re-reading so we don't lose arrivals
    // between the read and the watch registration.
    const deadline = Date.now() + Math.floor(timeoutSecs * 1000);
    let settled = false;
    let watcher = null;
    let intervalId = null;
    let timeoutId = null;
    let coalesceTimer = null;

    function cleanup() {
      if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
    }

    function finish(msgs) {
      if (settled) return;
      settled = true;
      cleanup();
      console.log(JSON.stringify({ messages: msgs }));
      process.exit(0);
    }

    function check() {
      if (settled) return;
      const msgs = readMessagesFiltered(inboxFile, afterSeq);
      if (msgs.length > 0) finish(msgs);
    }

    function scheduleCheck() {
      if (settled || coalesceTimer) return;
      // 50ms debounce: coalesce bursts of fs.watch events into one re-read.
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        check();
      }, 50);
    }

    process.on('SIGINT', () => finish([]));
    process.on('SIGTERM', () => finish([]));

    try {
      // Watch the dir, not the file path — atomic .tmp+rename in send invalidates
      // a file-path watch; dir-watch survives. macOS often delivers null filename
      // so we treat ANY event as a wake signal.
      watcher = watch(inboxDir, { persistent: false }, () => scheduleCheck());
    } catch (_) {
      // If fs.watch fails for any reason, the interval backstop carries us.
    }

    intervalId = setInterval(scheduleCheck, 500);

    // Re-read once after watcher is attached, in case a send landed in the gap.
    check();

    const remaining = Math.max(0, deadline - Date.now());
    timeoutId = setTimeout(() => finish([]), remaining);
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
} else {
  console.log(JSON.stringify({ error: `Unknown command: ${cmd}. Use 'send' or 'recv'.` }));
  process.exit(1);
}
