'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { appendSyntheticIfAbsent } = require('./channel');

const STOP_HOOK_COMMAND =
  'if [ -n "$CLAUDE_I_SENTINEL" ]; then cat > "$CLAUDE_I_SENTINEL.json"; touch "$CLAUDE_I_SENTINEL"; fi';

// Stale-lock threshold: mirror SESSION_LOCK_STALE_MS in lib/session.js so the
// withTuiLock recovery uses the exact same window as withSessionLock.
const SESSION_LOCK_STALE_MS = 10_000;

// Single-quote shell escape: wraps s in '' and escapes any embedded single quotes.
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build the tmux session name for a given sid + optional agent suffix.
 * Format: "advisor-<sid>" or "advisor-<sid>-<agent>"
 */
function makeTmuxName(sid, agent) {
  return agent ? `advisor-${sid}-${agent}` : `advisor-${sid}`;
}

/**
 * Build the tmux window name for the shared 'advisor' session.
 * Format: "<agent>-<sid>" or "worker-<sid>"
 */
function makeWindowName(agent, sid) {
  return agent ? `${agent}-${sid}` : `worker-${sid}`;
}

/**
 * Idempotently ensure the shared 'advisor' tmux session exists.
 * Names the initial placeholder window __advisor_scratch__ so it can be
 * killed by name (not index) once a real worker window is created.
 * Race-tolerant: swallows a concurrent-creation error from new-session,
 * then verifies via has-session — throws only if the session truly absent.
 *
 * @param {function} [execFn] - Optional exec override for tests.
 */
function ensureAdvisorSession(execFn) {
  const fn = execFn || ((cmd, args) =>
    execFileSync(cmd, args, { stdio: 'ignore' }));
  try {
    fn('tmux', ['new-session', '-d', '-s', 'advisor', '-x', '220', '-y', '50', '-n', '__advisor_scratch__']);
  } catch (_) {
    // Concurrent creation: the other caller won the race. Verify the session
    // exists (has-session exits 0) — succeed if so, propagate if not.
    fn('tmux', ['has-session', '-t', 'advisor']);
  }
}

/**
 * Synchronous mkdir-spinlock. Retries until the lock dir can be created or the
 * deadline passes. Runs fn() while the lock is held, releases in finally.
 *
 * @param {string} lockDir - path used as the mutex directory
 * @param {function} fn - synchronous function to run while lock is held
 * @returns the return value of fn
 */
function withTuiLock(lockDir, fn) {
  const deadline = Date.now() + 10000; // 10 s timeout
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when held
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(lockDir); } catch (_) {}
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
      if (Date.now() >= deadline) throw new Error('withTuiLock: timeout after 10s');
      // 20 ms synchronous back-off (no async scheduler in CLI path)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * Ensure the shared 'tui' window exists in the advisor tmux session, then
 * create a new pane for this worker (either via new-window or split-window),
 * tag it with the worker sid, and tile. Serialized by a filesystem spinlock
 * so concurrent --tui summons do not race.
 *
 * @param {string} sid - worker session id (used as pane title tag)
 * @param {object} [opts]
 * @param {function} [opts.execFn] - exec override for tests
 * @param {string}   [opts.lockDir] - override lock directory (for tests)
 * @returns {string} tmux pane_id of the allocated pane
 */
function ensureTuiPane(sid, opts = {}) {
  const lockDir = opts.lockDir ||
    path.join(os.homedir(), '.advisor', 'locks', 'tui-window.lock');
  const exec = opts.execFn || ((cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

  return withTuiLock(lockDir, () => {
    ensureAdvisorSession(exec);

    // Check whether the 'tui' window already exists in the advisor session.
    let windows = [];
    try {
      windows = exec('tmux', ['list-windows', '-t', 'advisor', '-F', '#{window_name}'])
        .trim().split('\n').filter(Boolean);
    } catch (_) {
      // Session may have just been created — no windows besides scratch yet.
    }

    if (!windows.includes('tui')) {
      // First --tui summon: create the shared window with a persistent placeholder pane.
      // The placeholder keeps the window (and session/server/Terminal client) alive
      // between workers so kill-pane on the last worker pane does not cascade to the
      // window or session.
      const placeholderPaneId = exec('tmux', [
        'new-window', '-d', '-t', 'advisor', '-n', 'tui', '-P', '-F', '#{pane_id}',
        '--', 'bash', '-c', "echo 'advisor: waiting for workers'; while :; do sleep 86400; done",
      ]).trim();
      exec('tmux', ['set-option', '-p', '-t', placeholderPaneId, '@advisor_placeholder', '1']);
      // Remove the placeholder scratch window now that a real window exists.
      try { exec('tmux', ['kill-window', '-t', 'advisor:__advisor_scratch__']); } catch (_) {}
    }

    // Worker pane: always split from the tui window (whether just created or pre-existing).
    const paneId = exec('tmux', [
      'split-window', '-d', '-t', 'advisor:tui', '-P', '-F', '#{pane_id}',
    ]).trim();

    // Tag the pane with the sid so close-worker-tab can locate and kill it.
    // Use a pane user-option (@advisor_sid), NOT the pane title: the claude TUI
    // overwrites the pane title with its own status line, but it cannot touch
    // tmux @-prefixed user options.
    exec('tmux', ['set-option', '-p', '-t', paneId, '@advisor_sid', sid]);

    // Re-tile after adding the new pane.
    exec('tmux', ['select-layout', '-t', 'advisor:tui', 'tiled']);

    return paneId;
  });
}

/**
 * Idempotently install the Stop hook into ~/.claude/settings.json (or settingsPath).
 * The hook writes the Stop payload to <sentinel>.json then touches <sentinel>.
 * Gated on $CLAUDE_I_SENTINEL so it is a no-op for sessions that don't set that var.
 *
 * @param {string} [settingsPath] - Override for tests; defaults to ~/.claude/settings.json
 */
function ensureStopHook(settingsPath) {
  const target = settingsPath || path.join(os.homedir(), '.claude', 'settings.json');

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    // missing or malformed — start fresh
  }

  const stopEntries = (settings.hooks && settings.hooks.Stop) || [];
  const alreadyInstalled = stopEntries
    .flatMap((e) => e.hooks || [])
    .some((h) => h.command === STOP_HOOK_COMMAND);

  if (alreadyInstalled) return;

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }],
  });

  // Atomic write: same-dir tmp + rename.
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Extract the last assistant message text from a claude transcript JSONL file.
 * Each line is a JSON object with shape { message: { role, content: [{type, text}] } }.
 * Malformed lines are skipped; missing file throws.
 */
function parseTranscript(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read transcript at ${transcriptPath}: ${err.message}`);
  }

  let lastText = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (!msg.message || msg.message.role !== 'assistant') continue;
      const content = msg.message.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) lastText = text;
      } else if (typeof content === 'string' && content) {
        lastText = content;
      }
    } catch (_) {
      // skip malformed line
    }
  }
  return lastText;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Default capture-pane wait; env override for CI / slow machines.
const DEFAULT_CAPTURE_TIMEOUT_MS =
  parseInt(process.env.ADVISOR_CAPTURE_TIMEOUT_MS || '30000', 10) || 30000;

// Poll capture-pane until any output appears (R1 mitigation: wait for claude boot).
async function pollCapturePane(target, maxWaitMs = DEFAULT_CAPTURE_TIMEOUT_MS, intervalMs = 200, execFn = null) {
  const doExec = execFn || ((cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const out = doExec('tmux', ['capture-pane', '-pt', target]);
      if (out.trim().length > 0) return;
    } catch (_) {
      // session may not be rendering yet
    }
    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
  }
}

async function pollSentinel(sentinelPath, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sentinelPath)) return true;
    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
  }
  return false;
}

// Sweep sentinel files older than 1 hour (R4: orphan cleanup on ensureStopHook).
function sweepStaleSentinels() {
  const cutoff = Date.now() - 3600 * 1000;
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (!/^claude-i-[0-9a-f]+\.done/.test(f)) continue;
      const fp = path.join(os.tmpdir(), f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Scan tmux for advisor-* sessions whose run directory is stale (session.json missing
 * or older than 24 h) AND which have no live claude process. Kill those sessions.
 * Also sweeps windows of the shared 'advisor' session when ADVISOR_TMUX_MULTIPLEX=1.
 *
 * Defensive: both conditions must hold before a session is killed.
 *
 * @param {object} [opts] - Injection points for tests.
 * @param {string} [opts.runsDir] - Override ~/.advisor/runs path.
 * @param {function} [opts.execFn] - Override execFileSync(cmd, args, {encoding:'utf8',...}).
 * @param {number} [opts.now] - Override Date.now() for mtime comparison.
 */
function reaperSweepOrphanSessions(opts = {}) {
  const runsDir = opts.runsDir || path.join(os.homedir(), '.advisor', 'runs');
  const execFn =
    opts.execFn ||
    ((cmd, args) =>
      execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
  const now = opts.now != null ? opts.now : Date.now();
  const cutoff24h = now - 24 * 3600 * 1000;

  // List tmux sessions; bail silently if tmux is unavailable.
  let sessions;
  try {
    sessions = execFn('tmux', ['ls', '-F', '#{session_name}'])
      .trim()
      .split('\n')
      .filter((n) => n && /^advisor-/.test(n));
  } catch (_) {
    return;
  }

  // Cache run-dir listing once (best-effort).
  let runDirEntries = [];
  try {
    runDirEntries = fs.readdirSync(runsDir);
  } catch (_) {}

  for (const sessionName of sessions) {
    const suffix = sessionName.slice('advisor-'.length); // sid or sid-agent

    // Find the matching run directory by checking if the session suffix equals an entry
    // or starts with entry + '-' (agent-suffix case).
    let runSid = null;
    let sessionJsonPath = null;
    for (const entry of runDirEntries) {
      if (suffix === entry || suffix.startsWith(entry + '-')) {
        runSid = entry;
        sessionJsonPath = path.join(runsDir, entry, 'session.json');
        break;
      }
    }

    // Staleness condition: no run dir found, or session.json missing/old.
    let isStale = true;
    if (sessionJsonPath) {
      try {
        const stat = fs.statSync(sessionJsonPath);
        isStale = stat.mtimeMs < cutoff24h;
      } catch (_) {
        isStale = true; // session.json absent
      }
    }

    if (!isStale) continue; // active session — never touch it

    // Live-process condition: pgrep -f <pattern> exits 0 if a matching process exists.
    // When runSid is null, derive pattern from session suffix.
    let hasLiveClaude = false;
    const pgrepPattern = runSid || suffix;
    try {
      execFn('pgrep', ['-f', pgrepPattern]);
      hasLiveClaude = true;
    } catch (_) {
      hasLiveClaude = false;
    }

    if (!hasLiveClaude) {
      try {
        execFn('tmux', ['kill-session', '-t', sessionName]);
      } catch (_) {}
    }
  }

  // Also sweep windows of the 'advisor' session (multiplex mode).
  if (process.env.ADVISOR_TMUX_MULTIPLEX === '1') {
    let advisorWindows = [];
    try {
      advisorWindows = execFn('tmux', ['list-windows', '-t', 'advisor', '-F', '#{window_name}'])
        .trim().split('\n').filter(Boolean);
    } catch (_) {
      return; // advisor session doesn't exist
    }

    for (const windowName of advisorWindows) {
      // Skip ensemble and tui windows — their lifecycle is managed by close-worker-tab/kill-pane.
      if (windowName.startsWith('ensemble-')) continue;
      // The shared 'tui' window is multi-worker and must never be reaped.
      if (windowName === 'tui' || windowName.startsWith('tui')) continue;

      // Window name format: <agent>-<fullsid> or worker-<fullsid>
      // Only reap windows that positively match a known run dir entry.
      const matchingEntry = runDirEntries.find(entry => windowName.endsWith('-' + entry));
      if (!matchingEntry) continue;

      const sessionJsonPath = path.join(runsDir, matchingEntry, 'session.json');
      let isStale = true;
      try {
        const stat = fs.statSync(sessionJsonPath);
        isStale = stat.mtimeMs < cutoff24h;
      } catch (_) {}

      if (!isStale) continue;

      let hasLive = false;
      try { execFn('pgrep', ['-f', matchingEntry]); hasLive = true; } catch (_) {}

      if (!hasLive) {
        try { execFn('tmux', ['kill-window', '-t', `advisor:${windowName}`]); } catch (_) {}
      }
    }
  }
}

// Hard cap on stale worktrees reaped per module-load sweep, so a large leaked
// backlog can never stall import. An explicit reapStaleWorktrees() (no limit)
// still drains everything.
const MAX_REAP_PER_LOAD = 25;

/**
 * Capture-then-remove stale coder git-worktrees that leaked because their
 * session ended without synthesize (the only path that called close-worker-tab).
 * Mirrors reaperSweepOrphanSessions' injectable test-seam pattern.
 *
 * For each `git worktree list --porcelain` entry on a `ws/<sid>` branch whose
 * session.json exists and is older than 24h AND which has no live claude
 * process. A worktree with NO session.json is spared (provisioning may still
 * be in flight), as is any worktree younger than ~1h (per its sid timestamp):
 * capture its working-tree delta into $runDir/output (Approach A) then issue
 * `worktree remove --force` + `branch -D`. Fail-closed: removal is skipped when
 * capture fails unless ADVISOR_FORCE_REMOVE_UNCAPTURED=1.
 *
 * @param {object} [opts] - Injection points for tests.
 * @param {string} [opts.runsDir] - Override ~/.advisor/runs path.
 * @param {string} [opts.repoRoot] - Override repo root (locates the worktrees + helper).
 * @param {function} [opts.execFn] - Override execFileSync for git/pgrep.
 * @param {function} [opts.captureFn] - Override the capture primitive (workspaceDir, outputDir, sid) => bool.
 * @param {number} [opts.now] - Override Date.now() for mtime comparison.
 * @param {number} [opts.limit] - Max stale worktrees to act on per call (those that
 *   passed the stale + no-live-process guards and reached the capture/remove step).
 *   Default null/undefined → no cap (drains the whole backlog).
 */
function reapStaleWorktrees(opts = {}) {
  const runsDir = opts.runsDir || path.join(os.homedir(), '.advisor', 'runs');
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
  const execFn =
    opts.execFn ||
    ((cmd, args) =>
      execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
  const now = opts.now != null ? opts.now : Date.now();
  const cutoff24h = now - 24 * 3600 * 1000;
  const forceRemove = process.env.ADVISOR_FORCE_REMOVE_UNCAPTURED === '1';
  const limit = opts.limit != null ? opts.limit : Infinity;
  let reaped = 0;

  // Default capture: source the bash helper and run _capture_worktree for real.
  const captureFn =
    opts.captureFn ||
    ((workspaceDir, outputDir, sid) => {
      const helper = path.join(repoRoot, 'bin', '_worktree-capture.sh');
      try {
        execFileSync('bash', [
          '-c',
          `source ${shquote(helper)} && _capture_worktree ${shquote(workspaceDir)} ${shquote(outputDir)} ${shquote(sid)}`,
        ], { stdio: 'ignore' });
        return true;
      } catch (_) {
        return false; // helper returned non-zero (fail-closed)
      }
    });

  // List registered worktrees; bail silently if git/list is unavailable.
  let out;
  try {
    out = execFn('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  } catch (_) {
    return;
  }

  // Parse porcelain blocks into {path, branch} entries.
  const entries = [];
  let cur = null;
  for (const line of String(out).split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null };
      entries.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length);
    }
  }

  for (const entry of entries) {
    if (!entry.branch) continue;
    const m = entry.branch.match(/^refs\/heads\/ws\/(.+)$/);
    if (!m) continue; // only sweep coder ws/<sid> worktrees
    const sid = m[1];

    // Grace floor: never reap a worktree younger than ~1h. The sid encodes
    // its provisioning time as a unix-seconds prefix (e.g. 1781084621-cf6431);
    // sids without that prefix get no grace (age unknown).
    const tsMatch = sid.match(/^(\d{9,})-/);
    if (tsMatch && now - Number(tsMatch[1]) * 1000 < 3600 * 1000) continue;

    // Staleness: session.json must exist AND be older than 24h. An absent
    // session.json can mean provisioning is still in flight (the worktree
    // exists before the run dir is populated) — spare it, never reap.
    const sessionJsonPath = path.join(runsDir, sid, 'session.json');
    let isStale = false;
    try {
      const stat = fs.statSync(sessionJsonPath);
      isStale = stat.mtimeMs < cutoff24h;
    } catch (_) {
      continue; // session.json absent — possibly mid-provision; spare it
    }
    if (!isStale) continue; // active session — never touch it

    // Live-process guard: pgrep -f <sid> exits 0 if a matching process exists.
    let hasLive = false;
    try { execFn('pgrep', ['-f', sid]); hasLive = true; } catch (_) {}
    if (hasLive) continue;

    // Per-call cap: stop once we've acted on `limit` worktrees.
    if (reaped >= limit) break;
    reaped++;

    // Capture-before-remove (fail-closed).
    const outputDir = path.join(runsDir, sid, 'output');
    const captured = captureFn(entry.path, outputDir, sid);
    if (!captured && !forceRemove) continue;

    try { execFn('git', ['-C', repoRoot, 'worktree', 'remove', '--force', entry.path]); } catch (_) {}
    try { execFn('git', ['-C', repoRoot, 'branch', '-D', `ws/${sid}`]); } catch (_) {}
  }
}

/**
 * Module-load reaper driver. Extracted so the opt-out gate is unit-testable
 * with injected spies (the import-time side effect cannot be re-triggered).
 *
 * @param {object} [env] - Environment object (defaults to process.env).
 * @param {object} [opts] - Override the reaper fns for spying in tests.
 */
function runLoadReapers(env = process.env, opts = {}) {
  if (env.ADVISOR_NO_REAPER === '1') return;
  const sweep = opts.reaperSweepOrphanSessions || reaperSweepOrphanSessions;
  const reap = opts.reapStaleWorktrees || reapStaleWorktrees;
  try { sweep(); } catch (_) {}
  try { reap({ limit: MAX_REAP_PER_LOAD }); } catch (_) {}
}

// Kill orphan advisor tmux sessions AND capture-then-remove stale coder
// worktrees at module load (best-effort, never throws). Gated behind
// ADVISOR_NO_REAPER so test imports and library consumers can disable it; the
// test harness sets ADVISOR_NO_REAPER=1 via tests/setup-no-reaper.js (bunfig
// preload) so `bun test` imports never sweep the real repo.
runLoadReapers();

/**
 * Spawn a headless claude worker via tmux + Stop hook.
 * When ADVISOR_TMUX_MULTIPLEX=1, uses the shared 'advisor' session with named windows.
 * Otherwise falls back to the legacy one-session-per-worker path.
 *
 * @param {object} opts
 * @param {string} opts.sid           - Unique session id.
 * @param {string} [opts.agent]       - Agent label.
 * @param {string} opts.launchScript  - Absolute path to the session's launch.sh.
 * @param {string} opts.promptFile    - Absolute path to the prompt file.
 * @param {string} opts.logFile       - Absolute path where claude output is captured.
 * @param {number} [opts.timeoutMs]   - Hard timeout in ms (default 5 min).
 * @param {string} [opts.paneId]      - Pre-created pane ID for ensemble mode (skips new-window).
 * @param {function} [opts.execFn]    - Exec override for tests (same pattern as reaperSweepOrphanSessions).
 * @returns {Promise<string>}           Last assistant response text from transcript.
 */
async function spawnHeadless({
  sid,
  agent,
  launchScript,
  promptFile,
  logFile,
  timeoutMs = 300_000,
  paneId: preCreatedPaneId = null,
  execFn: injectedExecFn = null,
}) {
  if (process.env.ADVISOR_TMUX_MULTIPLEX !== '1') {
    return _spawnHeadlessLegacy({ sid, agent, launchScript, promptFile, logFile, timeoutMs, execFn: injectedExecFn });
  }

  // --- MULTIPLEX PATH ---
  const exec = injectedExecFn || ((cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

  ensureStopHook();
  sweepStaleSentinels();

  const windowName = makeWindowName(agent, sid);
  const rand = crypto.randomBytes(8).toString('hex');
  const sentinel = path.join(os.tmpdir(), `claude-i-${rand}.done`);
  const sentinelJson = sentinel + '.json';
  const outboxPath = path.join(path.dirname(launchScript), 'channel', 'outbox.jsonl');

  const sealOutbox = (reason) => {
    try {
      appendSyntheticIfAbsent(outboxPath, {
        type: 'result',
        body: {
          summary: `worker exited without result (exit_code=unknown); reason=${reason}`,
          verdict: 'blocked',
          paths: [],
        },
        from: 'wrapper',
      });
    } catch (_) {}
  };

  let paneId;

  const cleanup = () => {
    if (paneId) {
      try { exec('tmux', ['kill-pane', '-t', paneId]); } catch (_) {}
    }
    try { fs.unlinkSync(sentinel); } catch (_) {}
    try { fs.unlinkSync(sentinelJson); } catch (_) {}
  };

  try {
    const promptContent = fs.readFileSync(promptFile, 'utf8');

    ensureAdvisorSession(injectedExecFn);

    if (preCreatedPaneId) {
      // Ensemble: pane already running a shell from split-window
      paneId = preCreatedPaneId;
      exec('tmux', ['pipe-pane', '-t', paneId, `cat >> ${shquote(logFile)}`]);
      exec('tmux', ['send-keys', '-t', paneId,
        `CLAUDE_I_SENTINEL=${shquote(sentinel)} exec bash ${shquote(launchScript)}`, 'Enter']);
    } else {
      // Solo: create new named window, capture pane ID
      paneId = exec('tmux', [
        'new-window', '-d', '-t', 'advisor', '-n', windowName,
        '-P', '-F', '#{pane_id}',
        '--', 'sh', '-c', `CLAUDE_I_SENTINEL=${shquote(sentinel)} bash ${shquote(launchScript)}`,
      ]).trim();
      // Kill placeholder scratch window by name (index recycling is unsafe)
      try { exec('tmux', ['kill-window', '-t', 'advisor:__advisor_scratch__']); } catch (_) {}
      exec('tmux', ['pipe-pane', '-t', paneId, `cat >> ${shquote(logFile)}`]);
    }

    // Wait for claude to boot and display its initial prompt.
    await pollCapturePane(paneId, DEFAULT_CAPTURE_TIMEOUT_MS, 200, injectedExecFn);

    // Inject prompt and submit.
    exec('tmux', ['set-buffer', '-b', paneId, promptContent]);
    exec('tmux', ['paste-buffer', '-t', paneId, '-b', paneId]);
    exec('tmux', ['send-keys', '-t', paneId, 'Enter']);

    // Poll until Stop hook fires.
    const done = await pollSentinel(sentinel, timeoutMs, 300);
    if (!done) {
      let stopReason = 'timeout';
      try {
        exec('tmux', ['display-message', '-t', paneId, '-F', 'alive']);
      } catch (_) {
        stopReason = 'pane-died';
      }
      cleanup();
      sealOutbox(stopReason);
      throw new Error(`spawnHeadless timed out after ${timeoutMs}ms (sid=${sid}, pane=${paneId}, reason=${stopReason})`);
    }

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(sentinelJson, 'utf8'));
    } catch (err) {
      cleanup();
      sealOutbox('stop-hook-but-no-result');
      throw new Error(`Failed to parse Stop hook payload: ${err.message}`);
    }

    const transcriptPath = payload.transcript_path;
    if (!transcriptPath) {
      cleanup();
      sealOutbox('stop-hook-but-no-result');
      throw new Error('Stop hook payload missing transcript_path');
    }

    const result = parseTranscript(transcriptPath);
    cleanup();
    // Happy path: worker wrote its own result; sealOutbox is a no-op in that case.
    sealOutbox('no-op-success');
    return result;
  } catch (err) {
    cleanup();
    sealOutbox('unexpected');
    throw err;
  }
}

/**
 * Legacy one-session-per-worker path (ADVISOR_TMUX_MULTIPLEX off).
 * Preserved bit-for-bit from the original spawnHeadless implementation.
 */
async function _spawnHeadlessLegacy({ sid, agent, launchScript, promptFile, logFile, timeoutMs = 300_000, execFn: injectedExecFn = null }) {
  ensureStopHook();
  sweepStaleSentinels();

  const exec = injectedExecFn || ((cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

  const tmuxName = makeTmuxName(sid, agent);
  const rand = crypto.randomBytes(8).toString('hex');
  const sentinel = path.join(os.tmpdir(), `claude-i-${rand}.done`);
  const sentinelJson = sentinel + '.json';
  const outboxPath = path.join(path.dirname(launchScript), 'channel', 'outbox.jsonl');

  const cleanup = () => {
    try { exec('tmux', ['kill-session', '-t', tmuxName]); } catch (_) {}
    try { fs.unlinkSync(sentinel); } catch (_) {}
    try { fs.unlinkSync(sentinelJson); } catch (_) {}
  };

  const sealOutbox = (reason) => {
    try {
      appendSyntheticIfAbsent(outboxPath, {
        type: 'result',
        body: {
          summary: `worker exited without result (exit_code=unknown); reason=${reason}`,
          verdict: 'blocked',
          paths: [],
        },
        from: 'wrapper',
      });
    } catch (_) {}
  };

  try {
    const promptContent = fs.readFileSync(promptFile, 'utf8');

    // Start tmux session with CLAUDE_I_SENTINEL exported into its environment.
    exec('tmux', [
      'new-session', '-d', '-s', tmuxName, '-x', '220', '-y', '50',
      'sh', '-c',
      `CLAUDE_I_SENTINEL=${shquote(sentinel)} bash ${shquote(launchScript)}`,
    ]);

    // Redirect pane output to logFile immediately after session creation.
    exec('tmux', ['pipe-pane', '-t', tmuxName, `cat >> ${shquote(logFile)}`]);

    // Wait for claude to boot and display its initial prompt (R1 mitigation).
    await pollCapturePane(tmuxName, DEFAULT_CAPTURE_TIMEOUT_MS, 200, injectedExecFn);

    // Inject prompt and submit.
    exec('tmux', ['set-buffer', '-b', tmuxName, promptContent]);
    exec('tmux', ['paste-buffer', '-t', tmuxName, '-b', tmuxName]);
    exec('tmux', ['send-keys', '-t', tmuxName, 'Enter']);

    // Poll until Stop hook fires (R4: hard timeout + cleanup).
    const done = await pollSentinel(sentinel, timeoutMs, 300);
    if (!done) {
      // Detect whether the pane died before the timeout or we just hit the limit.
      let stopReason = 'timeout';
      try {
        exec('tmux', ['has-session', '-t', tmuxName]);
      } catch (_) {
        stopReason = 'pane-died';
      }
      cleanup();
      sealOutbox(stopReason);
      throw new Error(`spawnHeadless timed out after ${timeoutMs}ms (sid=${sid}, tmux=${tmuxName})`);
    }

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(sentinelJson, 'utf8'));
    } catch (err) {
      cleanup();
      sealOutbox('stop-hook-but-no-result');
      throw new Error(`Failed to parse Stop hook payload: ${err.message}`);
    }

    const transcriptPath = payload.transcript_path;
    if (!transcriptPath) {
      cleanup();
      sealOutbox('stop-hook-but-no-result');
      throw new Error('Stop hook payload missing transcript_path');
    }

    const result = parseTranscript(transcriptPath);
    cleanup();
    // Happy path: worker wrote its own result; sealOutbox is a no-op in that case.
    sealOutbox('no-op-success');
    return result;
  } catch (err) {
    cleanup();
    sealOutbox('unexpected');
    throw err;
  }
}

module.exports = {
  spawnHeadless,
  ensureStopHook,
  parseTranscript,
  makeTmuxName,
  makeWindowName,
  ensureAdvisorSession,
  ensureTuiPane,
  pollCapturePane,
  reaperSweepOrphanSessions,
  reapStaleWorktrees,
  runLoadReapers,
};

// CLI entrypoint: node lib/tmux-runner.js --sid X --launch-script Y --prompt-file Z --log-file W [--pane-id P]
// or:              node lib/tmux-runner.js --ensure-tui-pane --sid X
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  if (args.includes('--ensure-tui-pane')) {
    const sid = get('--sid');
    if (!sid) {
      process.stderr.write('Usage: node lib/tmux-runner.js --ensure-tui-pane --sid <sid>\n');
      process.exit(1);
    }
    try {
      const paneId = ensureTuiPane(sid);
      process.stdout.write(paneId + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[tmux-runner] ensure-tui-pane error: ${err.message}\n`);
      process.exit(1);
    }
  }

  const sid = get('--sid');
  const agent = get('--agent') || undefined;
  const launchScript = get('--launch-script');
  const promptFile = get('--prompt-file');
  const logFile = get('--log-file');
  const timeoutMsRaw = get('--timeout-ms');
  const timeoutMs = timeoutMsRaw ? parseInt(timeoutMsRaw, 10) : 300_000;
  const paneId = get('--pane-id') || null;

  if (!sid || !launchScript || !promptFile || !logFile) {
    process.stderr.write(
      'Usage: node lib/tmux-runner.js --sid <sid> [--agent <agent>] --launch-script <path> ' +
        '--prompt-file <path> --log-file <path> [--timeout-ms <ms>] [--pane-id <id>]\n'
    );
    process.exit(1);
  }

  spawnHeadless({ sid, agent, launchScript, promptFile, logFile, timeoutMs, paneId }).then(
    (result) => {
      if (result) process.stdout.write(result + '\n');
      process.exit(0);
    },
    (err) => {
      process.stderr.write(`[tmux-runner] error: ${err.message}\n`);
      process.exit(1);
    }
  );
}
