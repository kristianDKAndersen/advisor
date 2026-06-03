import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const CLOSE_TAB = path.join(REPO, 'bin', 'close-tab');
const CLOSE_WORKER_TAB = path.join(REPO, 'bin', 'close-worker-tab');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-tab-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a fake binary in tmpDir/bin/<name> that appends its invocation to a log file,
 * then exits 0 (or exits <exitCode> if configured via FAKE_EXIT_<NAME> env var).
 */
function makeFakeBin(name, logFile, script = '') {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, name);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash\necho "${name} $*" >> ${JSON.stringify(logFile)}\n${script}\nexit 0\n`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

// ── close-tab: ADVISOR_TMUX=1 takes tmux branch ──────────────────────────────

test('close-tab: ADVISOR_TMUX=1 calls tmux kill-session, not osascript', () => {
  const log = path.join(tmpDir, 'calls.log');
  // Fake tmux: respond to display-message with a session name, record kill-session calls.
  const tmuxBin = path.join(tmpDir, 'bin', 'tmux');
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    tmuxBin,
    `#!/usr/bin/env bash
args="$*"
echo "tmux $args" >> ${JSON.stringify(log)}
if [[ "$1" == "display-message" ]]; then echo "advisor-test123-coder"; exit 0; fi
exit 0
`
  );
  fs.chmodSync(tmuxBin, 0o755);

  const osascriptLog = path.join(tmpDir, 'osascript.log');
  makeFakeBin('osascript', osascriptLog);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;

  const result = spawnSync('bash', [CLOSE_TAB], {
    env: {
      ...process.env,
      PATH: newPath,
      ADVISOR_TMUX: '1',
      ADVISOR_TMUX_MULTIPLEX: '', // isolate from host env: test non-multiplex path
      TMUX: '/tmp/tmux-1000/default,12345,0', // simulate being inside tmux
      PPID: String(process.pid), // point PPID at a real harmless PID
    },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const osacalls = fs.existsSync(osascriptLog) ? fs.readFileSync(osascriptLog, 'utf8') : '';

  expect(calls).toMatch(/kill-session/);
  expect(osacalls).toBe(''); // osascript must NOT be called
});

test('close-tab: no ADVISOR_TMUX and no TMUX env → skips tmux branch on non-Darwin', () => {
  // On non-Darwin, the script exits 0 early without calling tmux kill-session.
  // On Darwin CI we can't avoid osascript path — skip this branch check on Darwin.
  if (process.platform === 'darwin') return;

  const log = path.join(tmpDir, 'calls.log');
  makeFakeBin('tmux', log);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;
  spawnSync('bash', [CLOSE_TAB], {
    env: { ...process.env, PATH: newPath },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(calls).not.toMatch(/kill-session/);
});

// ── close-tab: TMUX env set with advisor- session name uses tmux branch ───────

test('close-tab: TMUX env + advisor- session name takes tmux branch without ADVISOR_TMUX=1', () => {
  const log = path.join(tmpDir, 'calls2.log');
  const tmuxBin = path.join(tmpDir, 'bin', 'tmux');
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    tmuxBin,
    `#!/usr/bin/env bash
echo "tmux $*" >> ${JSON.stringify(log)}
if [[ "$1" == "display-message" ]]; then echo "advisor-runxyz-worker"; exit 0; fi
exit 0
`
  );
  fs.chmodSync(tmuxBin, 0o755);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;
  spawnSync('bash', [CLOSE_TAB], {
    env: {
      ...process.env,
      PATH: newPath,
      ADVISOR_TMUX_MULTIPLEX: '', // isolate from host env: test non-multiplex path
      TMUX: '/tmp/tmux-1000/default,12345,0',
      PPID: String(process.pid),
    },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(calls).toMatch(/kill-session/);
});

// ── close-worker-tab: kills matching tmux session ────────────────────────────

test('close-worker-tab: kills advisor-<sid>* tmux sessions', () => {
  const sid = 'testrun-9999';
  // The script looks for $HOME/.advisor/runs/$sid; HOME is overridden to tmpDir.
  const runDir = path.join(tmpDir, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });

  const log = path.join(tmpDir, 'tmux.log');
  const tmuxBin = path.join(tmpDir, 'bin', 'tmux');
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    tmuxBin,
    `#!/usr/bin/env bash
echo "tmux $*" >> ${JSON.stringify(log)}
if [[ "$1" == "ls" ]]; then
  echo "advisor-${sid}-coder"
  exit 0
fi
exit 0
`
  );
  fs.chmodSync(tmuxBin, 0o755);

  // Fake ps so the first loop (claude kill by sid) doesn't error out.
  const psBin = path.join(tmpDir, 'bin', 'ps');
  fs.writeFileSync(psBin, `#!/usr/bin/env bash\nexit 0\n`);
  fs.chmodSync(psBin, 0o755);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;
  spawnSync('bash', [CLOSE_WORKER_TAB, sid], {
    env: {
      ...process.env,
      PATH: newPath,
      HOME: tmpDir,
    },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(calls).toMatch(/kill-session/);
  expect(calls).toMatch(new RegExp(`advisor-${sid}`));
});

test('close-worker-tab: no-op when sid is empty', () => {
  const result = spawnSync('bash', [CLOSE_WORKER_TAB, ''], { encoding: 'utf8' });
  expect(result.status).toBe(0);
});

// ── ADVISOR_TMUX_MULTIPLEX=1 close-tab tests ─────────────────────────────────

test('close-tab: ADVISOR_TMUX_MULTIPLEX=1 + ADVISOR_TMUX=1 calls kill-pane, not kill-session', () => {
  const log = path.join(tmpDir, 'multiplex-calls.log');
  const tmuxBin = path.join(tmpDir, 'bin', 'tmux');
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    tmuxBin,
    `#!/usr/bin/env bash
args="$*"
echo "tmux $args" >> ${JSON.stringify(log)}
if [[ "$1" == "display-message" ]]; then
  if [[ "$*" == *"#S"* ]]; then echo "advisor"; exit 0; fi
  if [[ "$*" == *"#{pane_id}"* ]]; then echo "%5"; exit 0; fi
fi
exit 0
`
  );
  fs.chmodSync(tmuxBin, 0o755);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;
  spawnSync('bash', [CLOSE_TAB], {
    env: {
      ...process.env,
      PATH: newPath,
      ADVISOR_TMUX: '1',
      ADVISOR_TMUX_MULTIPLEX: '1',
      TMUX: '/tmp/tmux-1000/default,12345,0',
      PPID: String(process.pid),
    },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(calls).toMatch(/kill-pane/);
  expect(calls).not.toMatch(/kill-session/);
});

test('close-tab: ADVISOR_TMUX_MULTIPLEX=1 + TMUX + session name "advisor" (exact) takes tmux branch', () => {
  const log = path.join(tmpDir, 'multiplex-exact.log');
  const tmuxBin = path.join(tmpDir, 'bin', 'tmux');
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    tmuxBin,
    `#!/usr/bin/env bash
args="$*"
echo "tmux $args" >> ${JSON.stringify(log)}
if [[ "$1" == "display-message" ]]; then
  if [[ "$*" == *"#S"* ]]; then echo "advisor"; exit 0; fi
  if [[ "$*" == *"#{pane_id}"* ]]; then echo "%42"; exit 0; fi
fi
exit 0
`
  );
  fs.chmodSync(tmuxBin, 0o755);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;
  spawnSync('bash', [CLOSE_TAB], {
    env: {
      ...process.env,
      PATH: newPath,
      ADVISOR_TMUX_MULTIPLEX: '1',
      TMUX: '/tmp/tmux-1000/default,12345,0',
      PPID: String(process.pid),
    },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(calls).toMatch(/kill-pane/);
  expect(calls).not.toMatch(/kill-session/);
});

test('close-tab: ADVISOR_TMUX_MULTIPLEX=1 + TMUX + session name "advisor-foo" does NOT take tmux branch', () => {
  const log = path.join(tmpDir, 'multiplex-nomatch.log');
  const tmuxBin = path.join(tmpDir, 'bin', 'tmux');
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    tmuxBin,
    `#!/usr/bin/env bash
args="$*"
echo "tmux $args" >> ${JSON.stringify(log)}
if [[ "$1" == "display-message" ]]; then echo "advisor-foo"; exit 0; fi
exit 0
`
  );
  fs.chmodSync(tmuxBin, 0o755);

  const newPath = `${path.join(tmpDir, 'bin')}:${process.env.PATH}`;
  spawnSync('bash', [CLOSE_TAB], {
    env: {
      ...process.env,
      PATH: newPath,
      ADVISOR_TMUX_MULTIPLEX: '1',
      TMUX: '/tmp/tmux-1000/default,12345,0',
      PPID: String(process.pid),
    },
  });

  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(calls).not.toMatch(/kill-pane/);
  expect(calls).not.toMatch(/kill-session/);
});
