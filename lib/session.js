// session.js — session id + ephemeral workspace + path resolution.
//
// Plumbing (every session): `~/.advisor/runs/<sid>/`
//   - channel/inbox.jsonl   (advisor → worker)
//   - channel/outbox.jsonl  (worker → advisor)
//   - workspace/            (copy of spawns/<name>/ — the worker's cwd)
//   - meta.json             ({sid, agent, task, goal, outputDir, repo, ...})
//   - bootstrap-prompt.txt  (prompt passed to the worker's `claude` invocation)
//   - launch.sh             (osascript entry point)
//
// Deliverables: `<git-root-of-invocation-cwd>/.advisor-output/<sid>/`
//   ...except self-invocation (cwd inside ADVISOR_ROOT), where they
//   fall back to the plumbing dir's `output/` subfolder.
//
// Override runs root with ADVISOR_RUNS_ROOT env if needed (tests).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ADVISOR_ROOT = path.resolve(__dirname, '..');
const RUNS_ROOT = process.env.ADVISOR_RUNS_ROOT || path.join(os.homedir(), '.advisor', 'runs');
// Back-compat alias for code that imported RUNS_DIR.
const RUNS_DIR = RUNS_ROOT;

// Test-only: inject a synchronous delay inside the lock to expose TOCTOU races.
// Set ADVISOR_TEST_UPDATE_DELAY_MS in the environment before loading this module.
const _testUpdateDelayMs = parseInt(process.env.ADVISOR_TEST_UPDATE_DELAY_MS || '0', 10);

// A lock dir older than this was left by a hard-killed process and is safe to remove.
const SESSION_LOCK_STALE_MS = 10_000;

// session.json v1 schema (written per-session to ~/.advisor/runs/<sid>/session.json):
// {
//   schema_version: 1,          // bump when shape changes
//   sid: string,
//   user_prompt: string,
//   tier: 'fact'|'comparison'|'deep_research'|'fixated'|'',
//   decomposition: [{           // one entry per spawned worker
//     role: string,
//     scope: string,
//     status: 'pending'|'in_progress'|'complete'|'blocked',
//     synthesis_seq: number|null
//   }],
//   decisions: [...],           // capped at 20; older entries drop on overflow
//   next_action: string
// }
const SESSION_SCHEMA_VERSION = 2;

function mintSessionId() {
  const ts = Math.floor(Date.now() / 1000);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${ts}-${rand}`;
}

function sessionDir(sid) {
  return path.join(RUNS_DIR, sid);
}

function channelDir(sid) {
  return path.join(sessionDir(sid), 'channel');
}

function inboxPath(sid) {
  return path.join(channelDir(sid), 'inbox.jsonl');
}

function outboxPath(sid) {
  return path.join(channelDir(sid), 'outbox.jsonl');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// agentName is used as a path component, so reject anything that could
// escape the spawns/ directory (path separators, traversal segments, NUL).
// Currently the Advisor controls agentName; this is defense in depth for
// when callers come from less trusted sources.
function validateAgentName(agentName) {
  if (typeof agentName !== 'string' || !agentName) {
    throw new Error(`Invalid agent name: ${JSON.stringify(agentName)}`);
  }
  if (
    agentName.includes('/') ||
    agentName.includes('\\') ||
    agentName.includes('..') ||
    agentName.includes('\0') ||
    agentName.startsWith('.')
  ) {
    throw new Error(
      `Invalid agent name: ${JSON.stringify(agentName)} — must not contain path separators, '..', NUL, or leading dot.`
    );
  }
}

function provisionWorkspace(sid, agentName) {
  validateAgentName(agentName);
  const src = path.join(ADVISOR_ROOT, 'spawns', agentName);
  if (!fs.existsSync(src) || !fs.existsSync(path.join(src, 'CLAUDE.md'))) {
    throw new Error(
      `Agent not found: spawns/${agentName}/ (must contain CLAUDE.md). ` +
        `Available: ${listAgents().join(', ') || '(none)'}`
    );
  }
  const dest = path.join(sessionDir(sid), 'workspace');
  copyDir(src, dest);
  return dest;
}

function listAgents() {
  const agentsDir = path.join(ADVISOR_ROOT, 'spawns');
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((n) => fs.existsSync(path.join(agentsDir, n, 'CLAUDE.md')));
}

// Atomic write: same-dir tmp + rename. Prevents `listSessions()` from
// observing a half-written meta.json during session creation.
function writeMeta(sid, meta) {
  const dir = sessionDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, 'meta.json');
  const tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, final);
  if (typeof Bun !== 'undefined') {
    try { const v = require('./vault.js'); v.writeSessionNote(meta); } catch (_) {}
  }
}

function writeSessionState(sid, state) {
  const dir = sessionDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, 'session.json');
  const tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, final);
}

function readSessionState(sid) {
  const p = path.join(sessionDir(sid), 'session.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function defaultSessionState(sid) {
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    sid,
    user_prompt: '',
    tier: '',
    decomposition: [],
    decisions: [],
    next_action: '',
    memory_blocks: {
      task_block:      { char_limit: 2000, content: '' },
      decisions_block: { char_limit: 2000, content: '' },
      gaps_block:      { char_limit: 2000, content: '' },
      verdict_block:   { char_limit: 1000, content: '' }
    }
  };
}

// POSIX-atomic mkdir-spinlock that serialises cross-process read-modify-write
// operations on a session's state file. Uses the same pattern as acquireSeqLock
// in channel.js: fs.mkdirSync throws EEXIST when the lock dir already exists,
// making acquisition atomic without any OS-level advisory lock.
function withSessionLock(sid, fn) {
  const dir = sessionDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, '.session.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when lock is held
      try {
        return fn();
      } finally {
        fs.rmdirSync(lockDir);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Remove stale lock left by a hard-killed process.
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > SESSION_LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) {
        throw new Error(`withSessionLock: timeout after 5s for sid=${sid}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function updateMemoryBlock(sid, blockName, content) {
  withSessionLock(sid, () => {
    const state = readSessionState(sid) || defaultSessionState(sid);
    if (!state.memory_blocks || !(blockName in state.memory_blocks)) {
      throw new Error(`Unknown memory block: ${blockName}`);
    }
    const block = state.memory_blocks[blockName];
    state.memory_blocks[blockName] = {
      char_limit: block.char_limit,
      content: content.slice(0, block.char_limit)
    };
    if (_testUpdateDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, _testUpdateDelayMs);
    writeSessionState(sid, state);
  });
}

function updateSessionState(sid, patchFn) {
  withSessionLock(sid, () => {
    const current = readSessionState(sid) || defaultSessionState(sid);
    if (_testUpdateDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, _testUpdateDelayMs);
    const updated = patchFn(current);
    writeSessionState(sid, updated);
  });
}

// ─── path resolution for deliverables ─────────────────────────────────────

// Run `git rev-parse --show-toplevel` in `cwd`. Returns the git root on
// success, or `null` if it's not inside a git repo. Callers distinguish
// git-repo vs cwd-fallback by checking for null (see `computeOutputDir`).
function getGitRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    return out || null;
  } catch (_e) {
    return null;
  }
}

// True if `cwd` is the advisor repo itself or a subdirectory of it.
// Uses realpath on both sides so symlinks don't fool the check.
function isInsideAdvisorRoot(cwd) {
  let rCwd, rRoot;
  try {
    rCwd = fs.realpathSync(cwd);
    rRoot = fs.realpathSync(ADVISOR_ROOT);
  } catch (_e) {
    return false;
  }
  return rCwd === rRoot || rCwd.startsWith(rRoot + path.sep);
}

// Decide where deliverables for `sid` should land, given the invocation cwd.
// Three cases, returned as distinct `reason` values so callers can handle
// each (the caller that warns/appends-gitignore/etc. is `lib/summon.js`):
//
//   - `self-invocation` — cwd inside advisor repo → `<plumbing>/output/`
//   - `git-root`        — cwd inside a git repo  → `<repo>/.advisor-output/<sid>/`
//   - `cwd-fallback`    — cwd NOT in a git repo  → `<cwd>/.advisor-output/<sid>/`
//
// The cwd-fallback case is intentionally distinct from git-root so the
// caller can warn the user (they may not expect output in e.g. /tmp/foo/)
// and skip .gitignore management (pointless without a .git/).
function computeOutputDir(sid, cwd) {
  if (isInsideAdvisorRoot(cwd)) {
    return {
      dir: path.join(sessionDir(sid), 'output'),
      reason: 'self-invocation',
      repo: ADVISOR_ROOT
    };
  }
  const gitRoot = getGitRoot(cwd);
  if (gitRoot) {
    return {
      dir: path.join(gitRoot, '.advisor-output', sid),
      reason: 'git-root',
      repo: gitRoot
    };
  }
  return {
    dir: path.join(cwd, '.advisor-output', sid),
    reason: 'cwd-fallback',
    repo: cwd
  };
}

// Append `.advisor-output/` to the repo's .gitignore if it's not already
// ignored. Returns true if a line was added, false if the file already
// covered it (including via a broader pattern like `.advisor-*`). Creates
// the file if missing.
function ensureGitignore(repoRoot) {
  const gi = path.join(repoRoot, '.gitignore');
  const target = '.advisor-output/';
  let content = '';
  try {
    content = fs.readFileSync(gi, 'utf8');
  } catch (_e) {
    // file doesn't exist — will create below
  }
  // Exact-line match only. Broader-pattern matching (e.g. `.advisor-*`) would
  // need a full gitignore parser; simpler to always add our explicit line.
  const hasLine = content
    .split('\n')
    .some((l) => l.trim() === target || l.trim() === '/' + target);
  if (hasLine) return false;
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  fs.appendFileSync(gi, `${needsNewline ? '\n' : ''}${target}\n`);
  return true;
}

// Walk RUNS_ROOT and return every session's meta.json, newest first.
// Resilient to half-written / malformed meta files (skips them).
function listSessions() {
  if (!fs.existsSync(RUNS_ROOT)) return [];
  const out = [];
  for (const sid of fs.readdirSync(RUNS_ROOT)) {
    const m = path.join(RUNS_ROOT, sid, 'meta.json');
    if (!fs.existsSync(m)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(m, 'utf8')));
    } catch (_e) {
      // skip malformed — likely a tmp file caught mid-write
    }
  }
  return out.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function readMeta(sid) {
  const p = path.join(sessionDir(sid), 'meta.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    process.stderr.write(`[session] readMeta(${sid}): malformed meta.json — ${e.message}\n`);
    return null;
  }
}

function ensureChannel(sid) {
  const cdir = channelDir(sid);
  fs.mkdirSync(cdir, { recursive: true });
  for (const f of ['inbox.jsonl', 'outbox.jsonl']) {
    const p = path.join(cdir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}

// Kill the tmux session for a worker after teardown.
// Wrapped in try-catch because the session may already be gone (Stop hook cleanup, timeout).
function killTmuxSession(sid) {
  if (process.env.ADVISOR_TMUX_MULTIPLEX === '1') {
    try {
      const wins = execFileSync('tmux',
        ['list-windows', '-t', 'advisor', '-F', '#{window_id} #{window_name}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const match = wins.split('\n').find(l => l.includes(sid));
      if (match) {
        const winId = match.trim().split(' ')[0];
        execFileSync('tmux', ['kill-window', '-t', `advisor:${winId}`], { stdio: 'ignore' });
      }
    } catch (_) {}
  } else {
    try {
      execFileSync('tmux', ['kill-session', '-t', sid], { stdio: 'ignore' });
    } catch (_) {
      // session already gone — not an error
    }
  }
}

module.exports = {
  SESSION_SCHEMA_VERSION,
  ADVISOR_ROOT,
  RUNS_ROOT,
  RUNS_DIR,
  mintSessionId,
  sessionDir,
  channelDir,
  inboxPath,
  outboxPath,
  provisionWorkspace,
  listAgents,
  writeMeta,
  readMeta,
  defaultSessionState,
  writeSessionState,
  readSessionState,
  updateSessionState,
  updateMemoryBlock,
  withSessionLock,
  ensureChannel,
  getGitRoot,
  isInsideAdvisorRoot,
  computeOutputDir,
  ensureGitignore,
  listSessions,
  killTmuxSession,
};
