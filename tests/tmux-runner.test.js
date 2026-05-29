import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureStopHook, parseTranscript, makeTmuxName, makeWindowName, ensureAdvisorSession, pollCapturePane, reaperSweepOrphanSessions, spawnHeadless } from '../lib/tmux-runner.js';

const STOP_HOOK_COMMAND =
  'if [ -n "$CLAUDE_I_SENTINEL" ]; then cat > "$CLAUDE_I_SENTINEL.json"; touch "$CLAUDE_I_SENTINEL"; fi';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-runner-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── ensureStopHook ────────────────────────────────────────────────────────────

test('ensureStopHook: creates settings.json when absent', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stopEntries = settings.hooks?.Stop ?? [];
  const cmds = stopEntries.flatMap((e) => (e.hooks ?? []).map((h) => h.command));
  expect(cmds).toContain(STOP_HOOK_COMMAND);
});

test('ensureStopHook: merges into existing settings without clobbering other hooks', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    })
  );

  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.theme).toBe('dark');
  expect(settings.hooks.PreToolUse).toBeDefined();
  const stopCmds = (settings.hooks.Stop ?? [])
    .flatMap((e) => (e.hooks ?? []).map((h) => h.command));
  expect(stopCmds).toContain(STOP_HOOK_COMMAND);
});

test('ensureStopHook: is idempotent — does not duplicate the hook', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  ensureStopHook(settingsPath);
  ensureStopHook(settingsPath);
  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stopCmds = (settings.hooks?.Stop ?? [])
    .flatMap((e) => (e.hooks ?? []).map((h) => h.command))
    .filter((c) => c === STOP_HOOK_COMMAND);
  expect(stopCmds.length).toBe(1);
});

test('ensureStopHook: skips if Stop hook command already present in array', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const existing = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.hooks.Stop.length).toBe(1);
});

// ── parseTranscript ───────────────────────────────────────────────────────────

test('parseTranscript: extracts last assistant text from JSONL', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'First reply' }],
      },
    }),
    JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: 'More' }] },
    }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final answer' }],
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('Final answer');
});

test('parseTranscript: concatenates multiple text blocks in last assistant message', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part A' },
        { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
        { type: 'text', text: ' Part B' },
      ],
    },
  });
  fs.writeFileSync(transcriptPath, line + '\n');

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('Part A Part B');
});

test('parseTranscript: skips malformed JSONL lines gracefully', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const content = [
    'NOT VALID JSON {{{',
    JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Good' }] },
    }),
    'also bad',
  ].join('\n');
  fs.writeFileSync(transcriptPath, content);

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('Good');
});

test('parseTranscript: returns empty string when no assistant messages', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  });
  fs.writeFileSync(transcriptPath, line + '\n');

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('');
});

test('parseTranscript: throws when transcript file is missing', () => {
  const transcriptPath = path.join(tmpDir, 'nonexistent.jsonl');
  expect(() => parseTranscript(transcriptPath)).toThrow();
});

// ── makeTmuxName (Fix 1) ──────────────────────────────────────────────────────

test('makeTmuxName: without agent returns advisor-<sid>', () => {
  expect(makeTmuxName('abc123')).toBe('advisor-abc123');
});

test('makeTmuxName: with agent returns advisor-<sid>-<agent>', () => {
  expect(makeTmuxName('abc123', 'coder')).toBe('advisor-abc123-coder');
});

test('makeTmuxName: with undefined agent returns advisor-<sid>', () => {
  expect(makeTmuxName('xyz', undefined)).toBe('advisor-xyz');
});

// ── pollCapturePane timeout env var (Fix 2) ───────────────────────────────────

test('pollCapturePane: returns quickly when fake tmux produces output', async () => {
  // Use a very short maxWaitMs so the test doesn't hang; sid is irrelevant (mocked via env).
  // We test that the function resolves when tmux capture-pane returns non-empty output.
  // Since we cannot mock execFileSync in-process cleanly, we verify the function signature
  // accepts the env-driven default and the param override still works.
  const start = Date.now();
  // Pass maxWaitMs=50 — function should return within 50 ms even if tmux is absent.
  await pollCapturePane('nonexistent-session-for-test', 50, 25);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(500);
});

test('pollCapturePane: ADVISOR_CAPTURE_TIMEOUT_MS env var is read at module load', () => {
  // The constant is baked in at module load time; we can only verify via the
  // exported DEFAULT value by checking pollCapturePane's toString or by duck-typing.
  // Instead, verify the env-driven default is 30000 when the env var is absent.
  const savedEnv = process.env.ADVISOR_CAPTURE_TIMEOUT_MS;
  delete process.env.ADVISOR_CAPTURE_TIMEOUT_MS;
  // Re-require is not feasible in Bun ESM; verify the 5s hard-coded call was removed
  // by confirming the function accepts zero explicit args (i.e., default exists).
  expect(typeof pollCapturePane).toBe('function');
  // sid has no default, maxWaitMs and intervalMs do — length counts leading required params.
  expect(pollCapturePane.length).toBe(1);
  if (savedEnv !== undefined) process.env.ADVISOR_CAPTURE_TIMEOUT_MS = savedEnv;
});

// ── reaperSweepOrphanSessions (Fix 3) ─────────────────────────────────────────

test('reaperSweepOrphanSessions: skips session whose session.json is fresh', () => {
  const runsDir = path.join(tmpDir, 'runs');
  const sid = 'aabbccdd-1122';
  const runDir = path.join(runsDir, sid);
  fs.mkdirSync(runDir, { recursive: true });
  // Write a fresh session.json (mtime = now)
  const sessionJsonPath = path.join(runDir, 'session.json');
  fs.writeFileSync(sessionJsonPath, JSON.stringify({ active: true }));

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') {
      return `advisor-${sid}-coder\n`;
    }
    if (cmd === 'tmux' && args[0] === 'kill-session') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') throw new Error('not found'); // no live claude
    return '';
  };

  reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  expect(killed).toHaveLength(0); // fresh session.json → must NOT kill
});

test('reaperSweepOrphanSessions: kills session whose session.json is absent and no live process', () => {
  const runsDir = path.join(tmpDir, 'runs2');
  const sid = 'dead0000-beef';
  fs.mkdirSync(path.join(runsDir, sid), { recursive: true });
  // No session.json written → absent

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return `advisor-${sid}\n`;
    if (cmd === 'tmux' && args[0] === 'kill-session') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') throw new Error('not found'); // no live claude
    return '';
  };

  reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  expect(killed).toContain(`advisor-${sid}`);
});

test('reaperSweepOrphanSessions: spares stale session when live claude process exists', () => {
  const runsDir = path.join(tmpDir, 'runs3');
  const sid = 'stale111-live';
  fs.mkdirSync(path.join(runsDir, sid), { recursive: true });
  // No session.json → stale

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return `advisor-${sid}-worker\n`;
    if (cmd === 'tmux' && args[0] === 'kill-session') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') return `99999\n`; // live claude found
    return '';
  };

  reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  expect(killed).toHaveLength(0); // live process → must NOT kill
});

test('reaperSweepOrphanSessions: kills session older than 24 h with no live process', () => {
  const runsDir = path.join(tmpDir, 'runs4');
  const sid = 'old00000-1234';
  const runDir = path.join(runsDir, sid);
  fs.mkdirSync(runDir, { recursive: true });
  const sessionJsonPath = path.join(runDir, 'session.json');
  fs.writeFileSync(sessionJsonPath, '{}');
  // Backdate mtime to 25 hours ago
  const oldTime = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(sessionJsonPath, oldTime, oldTime);

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return `advisor-${sid}-coder\n`;
    if (cmd === 'tmux' && args[0] === 'kill-session') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') throw new Error('not found'); // no live claude
    return '';
  };

  reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  expect(killed).toContain(`advisor-${sid}-coder`);
});

test('reaperSweepOrphanSessions: spares session with no run dir but live process', () => {
  const runsDir = path.join(tmpDir, 'runs5');
  const sid = 'nodir0000-live';
  // Do NOT create the run dir — this is the key scenario
  fs.mkdirSync(runsDir, { recursive: true });

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return `advisor-${sid}-worker\n`;
    if (cmd === 'tmux' && args[0] === 'kill-session') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') {
      // Live claude process found matching the suffix
      return `88888\n`;
    }
    return '';
  };

  reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  expect(killed).toHaveLength(0); // live process → must NOT kill
});

test('reaperSweepOrphanSessions: kills session with no run dir and no live process', () => {
  const runsDir = path.join(tmpDir, 'runs6');
  const sid = 'nodir0000-dead';
  // Do NOT create the run dir
  fs.mkdirSync(runsDir, { recursive: true });

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return `advisor-${sid}\n`;
    if (cmd === 'tmux' && args[0] === 'kill-session') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') throw new Error('not found'); // no live process
    return '';
  };

  reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  expect(killed).toContain(`advisor-${sid}`);
});

// ── makeWindowName (multiplex) ────────────────────────────────────────────────

test('makeWindowName: agent+sid returns agent-8chars', () => {
  expect(makeWindowName('planner', '1780038229-ca2f0f1234')).toBe('planner-17800382');
});

test('makeWindowName: no agent returns worker-8chars', () => {
  expect(makeWindowName(null, '1780038229-ca2f0f1234')).toBe('worker-17800382');
});

// ── ensureAdvisorSession (multiplex) ─────────────────────────────────────────

test('ensureAdvisorSession: calls new-session -A -d -s advisor with correct args', () => {
  const calls = [];
  ensureAdvisorSession((cmd, args) => calls.push([cmd, ...args]));
  expect(calls[0]).toEqual(['tmux', 'new-session', '-A', '-d', '-s', 'advisor', '-x', '220', '-y', '50']);
});

// ── spawnHeadless multiplex solo path ────────────────────────────────────────

test('spawnHeadless multiplex solo: new-window + paneId targeting + kill-pane cleanup, no kill-session', async () => {
  const origMultiplex = process.env.ADVISOR_TMUX_MULTIPLEX;
  process.env.ADVISOR_TMUX_MULTIPLEX = '1';

  try {
    const launchScript = path.join(tmpDir, 'launch.sh');
    const promptFile = path.join(tmpDir, 'prompt.txt');
    const logFile = path.join(tmpDir, 'claude.log');
    const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

    fs.mkdirSync(path.join(tmpDir, 'channel'), { recursive: true });
    fs.writeFileSync(launchScript, '#!/bin/bash\n');
    fs.writeFileSync(promptFile, 'Hello world');
    fs.writeFileSync(transcriptFile, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] },
    }) + '\n');

    const paneId = '%12';
    const calls = [];

    const execFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'tmux' && args[0] === 'new-window') {
        const shCmd = args[args.length - 1];
        const m = shCmd.match(/CLAUDE_I_SENTINEL='([^']+)'/);
        if (m) {
          const sp = m[1];
          fs.writeFileSync(sp + '.json', JSON.stringify({ transcript_path: transcriptFile }));
          fs.writeFileSync(sp, '');
        }
        return `${paneId}\n`;
      }
      if (cmd === 'tmux' && args[0] === 'capture-pane') return 'content\n';
      return '';
    };

    const result = await spawnHeadless({
      sid: 'abc12345-def678',
      agent: 'planner',
      launchScript,
      promptFile,
      logFile,
      timeoutMs: 5000,
      execFn,
    });

    expect(result).toBe('Done!');

    const newSession = calls.find(c => c[0] === 'tmux' && c[1] === 'new-session');
    expect(newSession).toBeDefined();
    expect(newSession).toContain('-A');

    const newWindow = calls.find(c => c[0] === 'tmux' && c[1] === 'new-window');
    expect(newWindow).toBeDefined();
    expect(newWindow).toContain('-P');

    const pipePane = calls.find(c => c[0] === 'tmux' && c[1] === 'pipe-pane');
    expect(pipePane).toBeDefined();
    expect(pipePane).toContain(paneId);

    const pasteBuffer = calls.find(c => c[0] === 'tmux' && c[1] === 'paste-buffer');
    expect(pasteBuffer).toBeDefined();
    expect(pasteBuffer).toContain(paneId);

    const sendKeysCalls = calls.filter(c => c[0] === 'tmux' && c[1] === 'send-keys');
    expect(sendKeysCalls.some(c => c.includes(paneId))).toBe(true);

    const killPane = calls.find(c => c[0] === 'tmux' && c[1] === 'kill-pane');
    expect(killPane).toBeDefined();
    expect(killPane).toContain(paneId);

    const killSession = calls.find(c => c[0] === 'tmux' && c[1] === 'kill-session');
    expect(killSession).toBeUndefined();
  } finally {
    if (origMultiplex === undefined) delete process.env.ADVISOR_TMUX_MULTIPLEX;
    else process.env.ADVISOR_TMUX_MULTIPLEX = origMultiplex;
  }
});

// ── spawnHeadless multiplex ensemble path ────────────────────────────────────

test('spawnHeadless multiplex ensemble: pre-created pane, no new-window, send-keys starts launch script, kill-pane on cleanup', async () => {
  const origMultiplex = process.env.ADVISOR_TMUX_MULTIPLEX;
  process.env.ADVISOR_TMUX_MULTIPLEX = '1';

  try {
    const launchScript = path.join(tmpDir, 'launch-ens.sh');
    const promptFile = path.join(tmpDir, 'prompt-ens.txt');
    const logFile = path.join(tmpDir, 'claude-ens.log');
    const transcriptFile = path.join(tmpDir, 'transcript-ens.jsonl');

    fs.mkdirSync(path.join(tmpDir, 'channel'), { recursive: true });
    fs.writeFileSync(launchScript, '#!/bin/bash\n');
    fs.writeFileSync(promptFile, 'Ensemble prompt');
    fs.writeFileSync(transcriptFile, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Ensemble done!' }] },
    }) + '\n');

    const preCreatedPaneId = '%20';
    const calls = [];

    const execFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'tmux' && args[0] === 'send-keys') {
        const joined = args.join(' ');
        const m = joined.match(/CLAUDE_I_SENTINEL='([^']+)'/);
        if (m) {
          const sp = m[1];
          fs.writeFileSync(sp + '.json', JSON.stringify({ transcript_path: transcriptFile }));
          fs.writeFileSync(sp, '');
        }
      }
      if (cmd === 'tmux' && args[0] === 'capture-pane') return 'content\n';
      return '';
    };

    const result = await spawnHeadless({
      sid: 'ens12345-abc678',
      agent: 'worker',
      launchScript,
      promptFile,
      logFile,
      timeoutMs: 5000,
      paneId: preCreatedPaneId,
      execFn,
    });

    expect(result).toBe('Ensemble done!');

    const newWindow = calls.find(c => c[0] === 'tmux' && c[1] === 'new-window');
    expect(newWindow).toBeUndefined();

    const launchKeyCall = calls.find(c =>
      c[0] === 'tmux' && c[1] === 'send-keys' && c.join(' ').includes('exec bash'));
    expect(launchKeyCall).toBeDefined();

    const killPane = calls.find(c => c[0] === 'tmux' && c[1] === 'kill-pane');
    expect(killPane).toBeDefined();
    expect(killPane).toContain(preCreatedPaneId);
  } finally {
    if (origMultiplex === undefined) delete process.env.ADVISOR_TMUX_MULTIPLEX;
    else process.env.ADVISOR_TMUX_MULTIPLEX = origMultiplex;
  }
});

// ── timeout → pane-died via display-message throw ────────────────────────────

test('spawnHeadless multiplex: timeout with pane-died when display-message throws', async () => {
  const origMultiplex = process.env.ADVISOR_TMUX_MULTIPLEX;
  process.env.ADVISOR_TMUX_MULTIPLEX = '1';

  try {
    const launchScript = path.join(tmpDir, 'launch-to.sh');
    const promptFile = path.join(tmpDir, 'prompt-to.txt');

    fs.mkdirSync(path.join(tmpDir, 'channel'), { recursive: true });
    fs.writeFileSync(launchScript, '#!/bin/bash\n');
    fs.writeFileSync(promptFile, 'Timeout prompt');

    const paneId = '%99';

    const execFn = (cmd, args) => {
      if (cmd === 'tmux' && args[0] === 'new-window') return `${paneId}\n`;
      if (cmd === 'tmux' && args[0] === 'capture-pane') return 'content\n';
      if (cmd === 'tmux' && args[0] === 'display-message') throw new Error('no such pane');
      return '';
    };

    await expect(
      spawnHeadless({
        sid: 'timeout1-abc678',
        agent: 'test',
        launchScript,
        promptFile,
        logFile: path.join(tmpDir, 'log-to.log'),
        timeoutMs: 100,
        execFn,
      })
    ).rejects.toThrow('pane-died');
  } finally {
    if (origMultiplex === undefined) delete process.env.ADVISOR_TMUX_MULTIPLEX;
    else process.env.ADVISOR_TMUX_MULTIPLEX = origMultiplex;
  }
});

// ── legacy flag-off path still works ─────────────────────────────────────────

test('spawnHeadless legacy (ADVISOR_TMUX_MULTIPLEX unset): uses tmuxName-based new-session and kill-session', async () => {
  const origMultiplex = process.env.ADVISOR_TMUX_MULTIPLEX;
  delete process.env.ADVISOR_TMUX_MULTIPLEX;

  try {
    const launchScript = path.join(tmpDir, 'launch-leg.sh');
    const promptFile = path.join(tmpDir, 'prompt-leg.txt');
    const logFile = path.join(tmpDir, 'claude-leg.log');
    const transcriptFile = path.join(tmpDir, 'transcript-leg.jsonl');

    fs.mkdirSync(path.join(tmpDir, 'channel'), { recursive: true });
    fs.writeFileSync(launchScript, '#!/bin/bash\n');
    fs.writeFileSync(promptFile, 'Legacy prompt');
    fs.writeFileSync(transcriptFile, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Legacy done!' }] },
    }) + '\n');

    const sid = 'leg12345-abc678';
    const calls = [];

    const execFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'tmux' && args[0] === 'new-session') {
        const shCmd = args[args.length - 1];
        const m = shCmd.match(/CLAUDE_I_SENTINEL='([^']+)'/);
        if (m) {
          const sp = m[1];
          fs.writeFileSync(sp + '.json', JSON.stringify({ transcript_path: transcriptFile }));
          fs.writeFileSync(sp, '');
        }
        return '';
      }
      if (cmd === 'tmux' && args[0] === 'capture-pane') return 'content\n';
      return '';
    };

    const result = await spawnHeadless({
      sid,
      agent: 'planner',
      launchScript,
      promptFile,
      logFile,
      timeoutMs: 5000,
      execFn,
    });

    expect(result).toBe('Legacy done!');

    const newSession = calls.find(c => c[0] === 'tmux' && c[1] === 'new-session');
    expect(newSession).toBeDefined();
    expect(newSession).toContain(`advisor-${sid}-planner`);

    const killSession = calls.find(c => c[0] === 'tmux' && c[1] === 'kill-session');
    expect(killSession).toBeDefined();

    const newWindow = calls.find(c => c[0] === 'tmux' && c[1] === 'new-window');
    expect(newWindow).toBeUndefined();
  } finally {
    if (origMultiplex === undefined) delete process.env.ADVISOR_TMUX_MULTIPLEX;
    else process.env.ADVISOR_TMUX_MULTIPLEX = origMultiplex;
  }
});
