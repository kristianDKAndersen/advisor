'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { appendSyntheticIfAbsent } = require('./channel');

const STOP_HOOK_COMMAND =
  'if [ -n "$CLAUDE_I_SENTINEL" ]; then cat > "$CLAUDE_I_SENTINEL.json"; touch "$CLAUDE_I_SENTINEL"; fi';

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
      // Skip ensemble windows — their lifecycle is managed by close-worker-tab/kill-pane.
      if (windowName.startsWith('ensemble-')) continue;

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

// Kill orphan advisor tmux sessions at module load (best-effort, never throws).
// Gate behind ADVISOR_NO_REAPER env opt-out so test imports and library consumers can disable it.
if (process.env.ADVISOR_NO_REAPER !== '1') {
  try { reaperSweepOrphanSessions(); } catch (_) {}
}

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
    sealOutbox('stop-hook-but-no-result');
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
    sealOutbox('stop-hook-but-no-result');
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
  pollCapturePane,
  reaperSweepOrphanSessions,
};

// CLI entrypoint: node lib/tmux-runner.js --sid X --launch-script Y --prompt-file Z --log-file W [--pane-id P]
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

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
