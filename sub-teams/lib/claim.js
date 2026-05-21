#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, watch, existsSync } from 'fs';
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

const args = parseArgs(process.argv.slice(2));
const runDir = args['run-dir'];
const role = args['role'];

if (!runDir || !role) {
  console.log(JSON.stringify({ error: '--run-dir and --role are required' }));
  process.exit(1);
}

const wait = args.wait === true || args.wait === 'true';
const timeoutSecs = args.timeout != null && args.timeout !== true
  ? parseFloat(args.timeout)
  : 300;

const taskListPath = join(runDir, 'task-list.json');
const lockDir = join(runDir, '.task-claim.lock');

function tryClaim() {
  // One attempt at acquiring the lock + scanning + claiming.
  // Returns: { claimed: task } | { claimed: null, allTerminal: bool } | throws on hard error.
  // The 5s lock-spin throw is treated as transient by the caller.
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        const list = JSON.parse(readFileSync(taskListPath, 'utf8'));
        const allTerminal = list.tasks.every(
          t => t.status === 'done' || t.status === 'failed',
        );
        const task = list.tasks.find(t =>
          t.status === 'pending' &&
          t.deps.every(dep => list.tasks.find(d => d.id === dep)?.status === 'done') &&
          (t.assigned_teammate == null || t.assigned_teammate === role),
        );

        if (!task) return { claimed: null, allTerminal };

        task.status = 'in_progress';
        task.claimed_by = role;
        task.claimed_at = Math.floor(Date.now() / 1000);

        const tmp = taskListPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(list, null, 2));
        renameSync(tmp, taskListPath);

        return { claimed: { task_id: task.id, input: task.input, status: 'in_progress' } };
      } finally {
        rmdirSync(lockDir);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error('claimNextTask: lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function readAllTerminal() {
  // Lock-free read — atomic rename gives consistent reads. Used before setting
  // up a new watch cycle so we don't wait when the run is already over.
  try {
    const list = JSON.parse(readFileSync(taskListPath, 'utf8'));
    return list.tasks.every(t => t.status === 'done' || t.status === 'failed');
  } catch (_) {
    return false;
  }
}

function emit(obj) {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

function tryClaimWithTransientRetry() {
  // Wraps tryClaim so the outer wait loop can treat lock-timeout as transient.
  try {
    return tryClaim();
  } catch (err) {
    if (/lock timeout/.test(err.message)) {
      process.stderr.write(`[claim] transient lock contention: ${err.message}\n`);
      return null; // signal: retry after short sleep
    }
    throw err;
  }
}

if (!wait) {
  try {
    const result = tryClaim();
    if (result.claimed) emit(result.claimed);
    emit({ status: 'none' });
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

// --wait path. Outer deadline; never reset by transient contention.
const overallDeadline = Date.now() + Math.floor(timeoutSecs * 1000);

let settled = false;
let watcher = null;
let intervalId = null;
let timeoutId = null;
let coalesceTimer = null;
let scanInFlight = false;

function cleanup() {
  if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
}

function finish(obj) {
  if (settled) return;
  settled = true;
  cleanup();
  emit(obj);
}

async function scan() {
  if (settled || scanInFlight) return;
  scanInFlight = true;
  try {
    // 1. All-terminal short-circuit (lock-free check before contending).
    if (readAllTerminal()) {
      finish({ status: 'none', reason: 'all_terminal' });
      return;
    }
    // 2. Attempt claim. Transient lock-timeout → null → caller sleeps + retries.
    const result = tryClaimWithTransientRetry();
    if (result === null) {
      await Bun.sleep(100);
      // Re-check terminal in case state moved while we slept.
      if (readAllTerminal()) {
        finish({ status: 'none', reason: 'all_terminal' });
        return;
      }
      // Fall through — wake handlers / interval will trigger another scan.
      return;
    }
    if (result.claimed) {
      finish(result.claimed);
      return;
    }
    if (result.allTerminal) {
      finish({ status: 'none', reason: 'all_terminal' });
      return;
    }
    // Nothing claimable yet; keep waiting.
  } catch (err) {
    if (settled) return;
    settled = true;
    cleanup();
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  } finally {
    scanInFlight = false;
  }
}

function scheduleScan() {
  if (settled || coalesceTimer) return;
  // 50ms debounce: coalesce bursts of task-list.json writes (reclaim sweep +
  // multiple completes) into one scan attempt.
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    scan();
  }, 50);
}

process.on('SIGINT', () => finish({ status: 'none', reason: 'interrupted' }));
process.on('SIGTERM', () => finish({ status: 'none', reason: 'interrupted' }));

try {
  // Ensure run_dir exists (it almost always does — defensive against tests).
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

  // Watch run_dir (not task-list.json directly — atomic rename invalidates a
  // file-path watch). Treat any event as a wake; macOS often gives null filename.
  try {
    watcher = watch(runDir, { persistent: false }, () => scheduleScan());
  } catch (_) {
    // fs.watch unavailable / failed — interval backstop is enough.
  }
  intervalId = setInterval(scheduleScan, 500);

  // First scan AFTER watcher is attached, so anything that lands between the
  // initial read and the watch registration still wakes us via the watcher.
  scan();

  const remaining = Math.max(0, overallDeadline - Date.now());
  timeoutId = setTimeout(() => finish({ status: 'none', reason: 'timeout' }), remaining);
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
