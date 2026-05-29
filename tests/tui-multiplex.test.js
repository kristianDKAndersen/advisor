import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureTuiPane, reaperSweepOrphanSessions } from '../lib/tmux-runner.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-multiplex-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── reaperSweepOrphanSessions: tui window must never be reaped ──────────────

test('reaper: tui window is skipped (never kill-window)', () => {
  const runsDir = path.join(tmpDir, 'runs');
  const sid = 'aabbccdd-0001';
  const runDir = path.join(runsDir, sid);
  fs.mkdirSync(runDir, { recursive: true });
  // No session.json — would normally be stale.

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return ''; // no advisor-* sessions
    if (cmd === 'tmux' && args[0] === 'list-windows') return 'tui\n__advisor_scratch__\n';
    if (cmd === 'tmux' && args[0] === 'kill-window') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') throw new Error('not found');
    return '';
  };

  const origEnv = process.env.ADVISOR_TMUX_MULTIPLEX;
  process.env.ADVISOR_TMUX_MULTIPLEX = '1';
  try {
    reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  } finally {
    if (origEnv === undefined) delete process.env.ADVISOR_TMUX_MULTIPLEX;
    else process.env.ADVISOR_TMUX_MULTIPLEX = origEnv;
  }

  expect(killed.some((t) => t.includes('tui'))).toBe(false);
});

test('reaper: tui-prefixed window is also skipped', () => {
  const runsDir = path.join(tmpDir, 'runs2');
  fs.mkdirSync(runsDir, { recursive: true });

  const killed = [];
  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'ls') return '';
    if (cmd === 'tmux' && args[0] === 'list-windows') return 'tui-extra\n';
    if (cmd === 'tmux' && args[0] === 'kill-window') {
      killed.push(args[args.indexOf('-t') + 1]);
      return '';
    }
    if (cmd === 'pgrep') throw new Error('not found');
    return '';
  };

  const origEnv = process.env.ADVISOR_TMUX_MULTIPLEX;
  process.env.ADVISOR_TMUX_MULTIPLEX = '1';
  try {
    reaperSweepOrphanSessions({ runsDir, execFn, now: Date.now() });
  } finally {
    if (origEnv === undefined) delete process.env.ADVISOR_TMUX_MULTIPLEX;
    else process.env.ADVISOR_TMUX_MULTIPLEX = origEnv;
  }

  expect(killed.some((t) => t.includes('tui'))).toBe(false);
});

// ── ensureTuiPane: window absent → new-window path ──────────────────────────

test('ensureTuiPane: window absent -> new-window, pane tagged, layout tiled', () => {
  const lockDir = path.join(tmpDir, 'tui-window.lock');
  const calls = [];
  let paneCounter = 0;

  const execFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    const joined = args.join(' ');
    // ensureAdvisorSession: new-session -> ok
    if (cmd === 'tmux' && args[0] === 'new-session') return '';
    // list-windows: return empty (no tui window)
    if (cmd === 'tmux' && args[0] === 'list-windows') return '';
    // new-window: return a pane id
    if (cmd === 'tmux' && args[0] === 'new-window') return `%${++paneCounter}\n`;
    // kill scratch window: ok
    if (cmd === 'tmux' && args[0] === 'kill-window') return '';
    // select-pane: ok
    if (cmd === 'tmux' && args[0] === 'select-pane') return '';
    // select-layout: ok
    if (cmd === 'tmux' && args[0] === 'select-layout') return '';
    return '';
  };

  const sid = 'test-sid-001';
  const paneId = ensureTuiPane(sid, { execFn, lockDir });

  // Must have called new-window (not split-window)
  const cmds = calls.map((c) => c[1]);
  expect(cmds).toContain('new-window');
  expect(cmds).not.toContain('split-window');

  // Must have tagged the pane with the sid via the @advisor_sid pane option
  // (NOT the title — claude overwrites the pane title).
  const tagCall = calls.find((c) => c[1] === 'set-option' && c.includes('@advisor_sid'));
  expect(tagCall).toBeDefined();
  expect(tagCall).toContain('-p');
  expect(tagCall).toContain(sid);

  // Must have tiled
  const layoutCall = calls.find((c) => c[1] === 'select-layout');
  expect(layoutCall).toBeDefined();
  expect(layoutCall).toContain('tiled');

  // Returned pane id must be non-empty
  expect(typeof paneId).toBe('string');
  expect(paneId.length).toBeGreaterThan(0);
});

// ── ensureTuiPane: window present → split-window path ───────────────────────

test('ensureTuiPane: window present -> split-window, pane tagged, layout tiled', () => {
  const lockDir = path.join(tmpDir, 'tui-window2.lock');
  const calls = [];
  let paneCounter = 10;

  const execFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === 'new-session') return '';
    // list-windows: return 'tui' (window already exists)
    if (cmd === 'tmux' && args[0] === 'list-windows') return 'tui\n';
    // split-window: return a pane id
    if (cmd === 'tmux' && args[0] === 'split-window') return `%${++paneCounter}\n`;
    if (cmd === 'tmux' && args[0] === 'select-pane') return '';
    if (cmd === 'tmux' && args[0] === 'select-layout') return '';
    return '';
  };

  const sid = 'test-sid-002';
  const paneId = ensureTuiPane(sid, { execFn, lockDir });

  const cmds = calls.map((c) => c[1]);
  // Must have called split-window (not new-window)
  expect(cmds).toContain('split-window');
  expect(cmds).not.toContain('new-window');
  // kill-window must NOT be called (scratch cleanup only on new-window path)
  expect(cmds).not.toContain('kill-window');

  // pane tagged via @advisor_sid pane option (not the title)
  const tagCall = calls.find((c) => c[1] === 'set-option' && c.includes('@advisor_sid'));
  expect(tagCall).toBeDefined();
  expect(tagCall).toContain('-p');
  expect(tagCall).toContain(sid);

  // select-layout tiled
  const layoutCall = calls.find((c) => c[1] === 'select-layout');
  expect(layoutCall).toBeDefined();
  expect(layoutCall).toContain('tiled');

  expect(typeof paneId).toBe('string');
  expect(paneId.length).toBeGreaterThan(0);
});

// ── ensureTuiPane: pane id comes from split-window output ───────────────────

test('ensureTuiPane: returns trimmed pane_id from command output', () => {
  const lockDir = path.join(tmpDir, 'tui-window3.lock');

  const execFn = (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'new-session') return '';
    if (cmd === 'tmux' && args[0] === 'list-windows') return 'tui\n';
    if (cmd === 'tmux' && args[0] === 'split-window') return '  %42  \n'; // leading/trailing whitespace
    if (cmd === 'tmux') return '';
    return '';
  };

  const paneId = ensureTuiPane('test-sid-003', { execFn, lockDir });
  expect(paneId).toBe('%42');
});
