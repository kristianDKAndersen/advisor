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

test('ensureTuiPane: window absent -> placeholder via new-window, worker via split-window, both tagged', () => {
  const lockDir = path.join(tmpDir, 'tui-window.lock');
  const calls = [];
  let paneCounter = 0;

  const execFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === 'new-session') return '';
    if (cmd === 'tmux' && args[0] === 'list-windows') return '';
    // new-window returns placeholder pane id
    if (cmd === 'tmux' && args[0] === 'new-window') return `%${++paneCounter}\n`;
    // split-window returns worker pane id
    if (cmd === 'tmux' && args[0] === 'split-window') return `%${++paneCounter}\n`;
    if (cmd === 'tmux' && args[0] === 'kill-window') return '';
    if (cmd === 'tmux' && args[0] === 'set-option') return '';
    if (cmd === 'tmux' && args[0] === 'select-layout') return '';
    return '';
  };

  const sid = 'test-sid-001';
  const paneId = ensureTuiPane(sid, { execFn, lockDir });

  const cmds = calls.map((c) => c[1]);
  // Both new-window (placeholder) and split-window (worker) must be called.
  expect(cmds).toContain('new-window');
  expect(cmds).toContain('split-window');

  // Placeholder pane must be tagged with @advisor_placeholder=1.
  const placeholderTag = calls.find((c) =>
    c[1] === 'set-option' && c.includes('@advisor_placeholder'));
  expect(placeholderTag).toBeDefined();
  expect(placeholderTag).toContain('-p');
  expect(placeholderTag).toContain('1');

  // Worker pane must be tagged with @advisor_sid (not the placeholder).
  const tagCall = calls.find((c) => c[1] === 'set-option' && c.includes('@advisor_sid'));
  expect(tagCall).toBeDefined();
  expect(tagCall).toContain('-p');
  expect(tagCall).toContain(sid);

  // Placeholder and worker pane ids must differ.
  const placeholderPaneId = placeholderTag[placeholderTag.indexOf('-t') + 1];
  const workerPaneId = tagCall[tagCall.indexOf('-t') + 1];
  expect(placeholderPaneId).not.toBe(workerPaneId);

  // Layout tiled.
  const layoutCall = calls.find((c) => c[1] === 'select-layout');
  expect(layoutCall).toBeDefined();
  expect(layoutCall).toContain('tiled');

  // Returned pane id (from split-window) must be non-empty.
  expect(typeof paneId).toBe('string');
  expect(paneId.length).toBeGreaterThan(0);
});

// ── ensureTuiPane: placeholder created once with @advisor_placeholder=1 ─────

test('ensureTuiPane: first window creation tags placeholder with @advisor_placeholder=1', () => {
  const lockDir = path.join(tmpDir, 'tui-placeholder.lock');
  const calls = [];
  let paneCounter = 0;

  const execFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === 'new-session') return '';
    if (cmd === 'tmux' && args[0] === 'list-windows') return ''; // no tui window
    if (cmd === 'tmux' && args[0] === 'new-window') return `%${++paneCounter}\n`;
    if (cmd === 'tmux' && args[0] === 'split-window') return `%${++paneCounter}\n`;
    if (cmd === 'tmux') return '';
    return '';
  };

  ensureTuiPane('placeholder-sid', { execFn, lockDir });

  // Exactly one @advisor_placeholder set-option call.
  const phCalls = calls.filter((c) =>
    c[1] === 'set-option' && c.includes('@advisor_placeholder'));
  expect(phCalls).toHaveLength(1);
  const pc = phCalls[0];
  expect(pc).toContain('-p');
  expect(pc).toContain('1');

  // @advisor_placeholder and @advisor_sid set on DIFFERENT panes.
  const sidCalls = calls.filter((c) =>
    c[1] === 'set-option' && c.includes('@advisor_sid'));
  expect(sidCalls).toHaveLength(1);
  const phPaneId = pc[pc.indexOf('-t') + 1];
  const workerPaneId = sidCalls[0][sidCalls[0].indexOf('-t') + 1];
  expect(phPaneId).not.toBe(workerPaneId);
});

// ── ensureTuiPane: existing window with placeholder is reused ────────────────

test('ensureTuiPane: existing tui window with placeholder reused via split-window, not new-window', () => {
  const lockDir = path.join(tmpDir, 'tui-reuse.lock');
  const calls = [];
  let paneCounter = 20;

  const execFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === 'new-session') return '';
    // tui window already exists (placeholder kept it alive after previous worker left)
    if (cmd === 'tmux' && args[0] === 'list-windows') return 'tui\n';
    if (cmd === 'tmux' && args[0] === 'split-window') return `%${++paneCounter}\n`;
    if (cmd === 'tmux') return '';
    return '';
  };

  const paneId = ensureTuiPane('reuse-sid', { execFn, lockDir });

  const cmds = calls.map((c) => c[1]);
  // Window already exists — must split, never create a new window.
  expect(cmds).toContain('split-window');
  expect(cmds).not.toContain('new-window');
  expect(cmds).not.toContain('kill-window');

  // Worker pane tagged with @advisor_sid.
  const tagCall = calls.find((c) => c[1] === 'set-option' && c.includes('@advisor_sid'));
  expect(tagCall).toBeDefined();
  expect(tagCall).toContain('reuse-sid');

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
