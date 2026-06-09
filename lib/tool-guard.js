#!/usr/bin/env node
// PreToolUse hook: blocks Edit/Write/NotebookEdit to spec-authored protected test paths.
// Convention (same as workspace-guard.js): exit 2 = block, stdout = reason shown to Claude.
'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const counts = new Map();

function sortedJSON(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return JSON.stringify(val);
  }
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedJSON(val[k])).join(',') + '}';
}

function canonicalHash(toolName, args) {
  const payload = JSON.stringify(toolName) + ':' + sortedJSON(args);
  return createHash('sha256').update(payload).digest('hex');
}

function checkDuplicate(toolName, args) {
  const sig = canonicalHash(toolName, args);
  const count = (counts.get(sig) ?? 0) + 1;
  counts.set(sig, count);
  const duplicate = count >= 3;
  return { duplicate, count, halt: duplicate };
}

function resetState() {
  counts.clear();
}

// Pure function — safe to unit test without I/O.
// Returns true when toolName is a write tool AND filePath is in protectedList.
// protectedList null/empty -> always returns false (gate inert).
function isProtectedWrite(toolName, filePath, protectedList) {
  const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
  if (!WRITE_TOOLS.has(toolName)) return false;
  if (!protectedList || protectedList.length === 0) return false;
  const resolved = path.resolve(filePath);
  return protectedList.some(p => path.resolve(p) === resolved);
}

// Internal: returns true when `cmd` writes to the resolved absolute path `abs`.
// Heuristic-only — shell variable expansion, computed paths, and eval/base64
// indirection can still evade detection. Raises the bar; not a hermetic seal.
function _commandWritesTo(cmd, abs) {
  if (!cmd.includes(abs)) return false;
  // Escape the path for use in a RegExp literal.
  const e = abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // Redirect: cmd > path  or  cmd >> path
    new RegExp(`>>?\\s*${e}(?:\\s|$)`),
    // tee [flags] path  (tee -a, tee --append, etc.)
    new RegExp(`\\btee(?:\\s+-\\S+)*\\s+${e}(?:\\s|$)`),
    // sed -i  (in-place edit; -i may be combined: -Ei, -ni, etc.)
    new RegExp(`\\bsed\\b(?=[^|;]*\\s-[a-zA-Z]*i)[^|;]*\\s${e}(?:\\s|$)`),
    // cp / mv with protected path as DESTINATION (last token before segment end)
    new RegExp(`\\b(?:cp|mv)\\b[^|;]*\\s${e}(?=\\s*(?:;|&&|\\|\\||[)\\]}]|$))`),
    // dd of=path
    new RegExp(`\\bdd\\b[^|;]*?\\bof=${e}(?:\\s|$)`),
    // chmod / chflags / chown path  (metadata write)
    new RegExp(`\\b(?:chmod|chflags|chown)\\b[^|;]*\\s${e}(?:\\s|$)`),
    // truncate path
    new RegExp(`\\btruncate\\b[^|;]*\\s${e}(?:\\s|$)`),
    // ed / ex  (line-mode in-place editors)
    new RegExp(`\\b(?:ed|ex)\\b[^|;]*${e}(?:\\s|$)`),
    // vim -c  (scripted vim invocation; only block when -c flag present)
    new RegExp(`\\bvim\\b[^|;]*-c[^|;]*${e}(?:\\s|$)`),
    // perl -i  (in-place; -i may be combined: -pi, -0pi, etc.)
    new RegExp(`\\bperl\\b(?=[^|;]*\\s-[a-zA-Z0-9]*i)[^|;]*\\s${e}(?:\\s|$)`),
    // python -c "... path ..."  (inline script; conservative — block on any -c mention)
    new RegExp(`\\bpython3?\\s+-c\\b[^|;]*${e}`),
  ].some(re => re.test(cmd));
}

// Pure exported helper. Returns true when `command` writes to at least one path
// in protectedList. Returns false when protectedList is null/empty (gate inert).
function bashWritesToProtected(command, protectedList) {
  if (!command || !protectedList || protectedList.length === 0) return false;
  for (const p of protectedList) {
    if (_commandWritesTo(command, path.resolve(p))) return true;
  }
  return false;
}

function _countsPath(sid) {
  const runsRoot = process.env.ADVISOR_RUNS_ROOT ||
    path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.advisor', 'runs');
  return path.join(runsRoot, sid, 'tool-counts.json');
}

function _readCounts(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return {};
  }
}

// A lock dir older than this was left by a hard-killed process and is safe to remove.
const TOOL_COUNTS_LOCK_STALE_MS = 10_000;

// Increments the count for `sig` in the session-scoped counts file under
// ADVISOR_RUNS_ROOT/<sid>/tool-counts.json. Uses a POSIX-atomic mkdir mutex.
// Returns the new count, or 0 on any error (fail-open).
function _incrementCount(sid, sig) {
  const p = _countsPath(sid);
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const lockDir = path.join(dir, '.tool-counts.lock');
  const deadline = Date.now() + 5000;
  let count = 0;
  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when lock is held
      try {
        const counts = _readCounts(p);
        count = (counts[sig] ?? 0) + 1;
        counts[sig] = count;
        fs.writeFileSync(p, JSON.stringify(counts));
      } finally {
        try { fs.rmdirSync(lockDir); } catch (_) {}
      }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break; // fail-open on unexpected errors
      // Remove stale lock left by a hard-killed process.
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > TOOL_COUNTS_LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) break; // fail-open on timeout
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return count;
}

module.exports = { canonicalHash, checkDuplicate, resetState, isProtectedWrite, bashWritesToProtected };

// --- PreToolUse main entry ---
// Only runs when invoked directly (node lib/tool-guard.js), not when required.
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { process.exit(0); }

    const { tool_name, tool_input } = msg;

    // Persist duplicate-call counts across subprocess invocations.
    // If ADVISOR_SID is absent, dedup is disabled (fail-open).
    const sid = process.env.ADVISOR_SID;
    if (sid) {
      const sig = canonicalHash(tool_name, tool_input || {});
      const count = _incrementCount(sid, sig);
      if (count >= 3) {
        process.stdout.write(
          `tool-guard: loop detected — halting worker (count=${count} for sig=${sig.slice(0, 8)}...)\n`
        );
        process.exit(2);
      }
    }

    const envVal = process.env.ADVISOR_PROTECTED_TESTS;
    let protectedList = null;
    if (envVal) {
      try { protectedList = JSON.parse(envVal); } catch { protectedList = null; }
    }

    // Block Edit / Write / NotebookEdit to a protected path.
    const filePath = tool_input && tool_input.file_path;
    if (filePath && isProtectedWrite(tool_name, filePath, protectedList)) {
      process.stdout.write(
        `tool-guard: blocked ${tool_name} to spec-authored protected test path: ${filePath}\n` +
        `The Advisor spec authored these tests — you must NOT modify them.\n` +
        `If you cannot make the tests pass without modifying them, send verdict=blocked naming the specific unsatisfiable assertion.\n`
      );
      process.exit(2);
    }

    // Block Bash commands that write to a protected path.
    if (tool_name === 'Bash') {
      const command = tool_input && tool_input.command;
      if (bashWritesToProtected(command, protectedList)) {
        process.stdout.write(
          `tool-guard: blocked Bash write to a spec-authored protected test path.\n` +
          `Command: ${command}\n` +
          `The Advisor spec authored these tests — you must NOT modify them.\n` +
          `If you cannot make the tests pass without modifying them, send verdict=blocked naming the specific unsatisfiable assertion.\n`
        );
        process.exit(2);
      }
    }

    process.exit(0);
  });
}
