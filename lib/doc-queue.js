'use strict';
// lib/doc-queue.js — durable JSONL queue for background doc-agent work.
//
// Queue file: ~/.advisor/doc-queue.jsonl (override via ADVISOR_DOC_QUEUE env var).
// Both enqueue and markProcessed hold a mkdir-spinlock (same pattern as
// acquireSeqLock in channel.js) so a concurrent enqueue cannot be silently
// overwritten by markProcessed's read-modify-write.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STALE_LOCK_MS = 10_000;

function queuePath() {
  return process.env.ADVISOR_DOC_QUEUE ||
    path.join(os.homedir(), '.advisor', 'doc-queue.jsonl');
}

function ensureFile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

function acquireLock(queueDir) {
  const lockDir = path.join(queueDir, '.doc-queue.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when held
      return lockDir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) {
        throw new Error(`doc-queue: lock timeout in ${queueDir}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function releaseLock(lockDir) {
  try { fs.rmdirSync(lockDir); } catch (_) {}
}

// Append one entry to the queue atomically.
// Holds the same lock used by markProcessed so a concurrent markProcessed
// read-modify-write cannot overwrite this append.
function enqueue(entry) {
  const p = queuePath();
  ensureFile(p);
  const lockDir = acquireLock(path.dirname(p));
  try {
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } finally {
    releaseLock(lockDir);
  }
}

// Return all entries that do not have processed:true.
// No lock required — read-only; callers tolerate a slightly stale snapshot.
function dequeueUnprocessed() {
  const p = queuePath();
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.processed) entries.push(entry);
    } catch (_) {}
  }
  return entries;
}

// Set processed:true for each {sid, seq} pair in keys.
// Holds the lock around the full read-modify-write so a concurrent enqueue
// (which also holds the lock) cannot be lost: it either runs before this write
// or after, never between the read and the write.
function markProcessed(keys) {
  if (!keys || keys.length === 0) return;
  const p = queuePath();
  ensureFile(p);
  const lockDir = acquireLock(path.dirname(p));
  try {
    const keySet = new Set(keys.map(k => `${k.sid}:${k.seq}`));
    const content = fs.readFileSync(p, 'utf8');
    const updated = content.split('\n').map(line => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);
        if (keySet.has(`${entry.sid}:${entry.seq}`)) {
          return JSON.stringify({ ...entry, processed: true });
        }
        return line;
      } catch (_) {
        return line;
      }
    }).join('\n');
    fs.writeFileSync(p, updated);
  } finally {
    releaseLock(lockDir);
  }
}

module.exports = { enqueue, dequeueUnprocessed, markProcessed };
