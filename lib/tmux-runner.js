'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const STOP_HOOK_COMMAND =
  'if [ -n "$CLAUDE_I_SENTINEL" ]; then cat > "$CLAUDE_I_SENTINEL.json"; touch "$CLAUDE_I_SENTINEL"; fi';

// Single-quote shell escape: wraps s in '' and escapes any embedded single quotes.
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
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

// Poll capture-pane until any output appears (R1 mitigation: wait for claude boot).
async function pollCapturePane(sid, maxWaitMs = 5000, intervalMs = 200) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('tmux', ['capture-pane', '-pt', sid], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
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
 * Spawn a headless claude worker via tmux + Stop hook.
 *
 * @param {object} opts
 * @param {string} opts.sid           - Unique session id (used as tmux session name).
 * @param {string} opts.launchScript  - Absolute path to the session's launch.sh.
 * @param {string} opts.promptFile    - Absolute path to the prompt file.
 * @param {string} opts.logFile       - Absolute path where claude output is captured.
 * @param {number} [opts.timeoutMs]   - Hard timeout in ms (default 5 min). R4.
 * @returns {Promise<string>}           Last assistant response text from transcript.
 */
async function spawnHeadless({ sid, launchScript, promptFile, logFile, timeoutMs = 300_000 }) {
  ensureStopHook();
  sweepStaleSentinels();

  const rand = crypto.randomBytes(8).toString('hex');
  const sentinel = path.join(os.tmpdir(), `claude-i-${rand}.done`);
  const sentinelJson = sentinel + '.json';

  const cleanup = () => {
    try { execFileSync('tmux', ['kill-session', '-t', sid], { stdio: 'ignore' }); } catch (_) {}
    try { fs.unlinkSync(sentinel); } catch (_) {}
    try { fs.unlinkSync(sentinelJson); } catch (_) {}
  };

  try {
    const promptContent = fs.readFileSync(promptFile, 'utf8');

    // Start tmux session with CLAUDE_I_SENTINEL exported into its environment.
    execFileSync('tmux', [
      'new-session', '-d', '-s', sid, '-x', '220', '-y', '50',
      'sh', '-c',
      `CLAUDE_I_SENTINEL=${shquote(sentinel)} bash ${shquote(launchScript)}`,
    ], { stdio: 'ignore' });

    // Redirect pane output to logFile immediately after session creation.
    // (pipe-pane called before any output to minimise the R6 race window.)
    execFileSync('tmux', ['pipe-pane', '-t', sid, `cat >> ${shquote(logFile)}`], {
      stdio: 'ignore',
    });

    // Wait for claude to boot and display its initial prompt (R1 mitigation).
    await pollCapturePane(sid, 5000, 200);

    // Inject prompt and submit.
    execFileSync('tmux', ['set-buffer', '-b', sid, promptContent], { stdio: 'ignore' });
    execFileSync('tmux', ['paste-buffer', '-t', sid, '-b', sid], { stdio: 'ignore' });
    execFileSync('tmux', ['send-keys', '-t', sid, 'Enter'], { stdio: 'ignore' });

    // Poll until Stop hook fires (R4: hard timeout + cleanup).
    const done = await pollSentinel(sentinel, timeoutMs, 300);
    if (!done) {
      cleanup();
      throw new Error(`spawnHeadless timed out after ${timeoutMs}ms (sid=${sid})`);
    }

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(sentinelJson, 'utf8'));
    } catch (err) {
      cleanup();
      throw new Error(`Failed to parse Stop hook payload: ${err.message}`);
    }

    const transcriptPath = payload.transcript_path;
    if (!transcriptPath) {
      cleanup();
      throw new Error('Stop hook payload missing transcript_path');
    }

    const result = parseTranscript(transcriptPath);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

module.exports = { spawnHeadless, ensureStopHook, parseTranscript };

// CLI entrypoint: node lib/tmux-runner.js --sid X --launch-script Y --prompt-file Z --log-file W
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  const sid = get('--sid');
  const launchScript = get('--launch-script');
  const promptFile = get('--prompt-file');
  const logFile = get('--log-file');
  const timeoutMsRaw = get('--timeout-ms');
  const timeoutMs = timeoutMsRaw ? parseInt(timeoutMsRaw, 10) : 300_000;

  if (!sid || !launchScript || !promptFile || !logFile) {
    process.stderr.write(
      'Usage: node lib/tmux-runner.js --sid <sid> --launch-script <path> ' +
        '--prompt-file <path> --log-file <path> [--timeout-ms <ms>]\n'
    );
    process.exit(1);
  }

  spawnHeadless({ sid, launchScript, promptFile, logFile, timeoutMs }).then(
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
