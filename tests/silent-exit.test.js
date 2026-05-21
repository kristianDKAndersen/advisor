import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { appendSyntheticIfAbsent } from '../lib/channel.js';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const ADVISOR_OBSERVE = path.resolve(import.meta.dir, '../bin/advisor-observe');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-exit-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeOutbox(dir) {
  const channelDir = path.join(dir, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const outboxPath = path.join(channelDir, 'outbox.jsonl');
  fs.writeFileSync(outboxPath, '');
  return outboxPath;
}

function appendLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

// ── appendSyntheticIfAbsent ───────────────────────────────────────────────────

test('appendSyntheticIfAbsent: adds synthetic result when outbox has no result', () => {
  const outbox = makeOutbox(tmpDir);
  appendLine(outbox, { ts: 1, type: 'progress', body: 'working', from: 'worker', seq: 1 });

  const result = appendSyntheticIfAbsent(outbox, {
    type: 'result',
    body: { summary: 'worker exited without result (exit_code=1)', verdict: 'blocked', paths: [] },
    from: 'wrapper',
  });

  expect(result).not.toBeNull();
  const msgs = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const resultMsgs = msgs.filter(m => m.type === 'result');
  expect(resultMsgs.length).toBe(1);
  expect(resultMsgs[0].from).toBe('wrapper');
  expect(resultMsgs[0].body.verdict).toBe('blocked');
  expect(resultMsgs[0].body.summary).toContain('exit_code=1');
});

test('appendSyntheticIfAbsent: does NOT add synthetic when result already exists', () => {
  const outbox = makeOutbox(tmpDir);
  appendLine(outbox, { ts: 1, type: 'result', body: { summary: 'done', verdict: 'complete', paths: [] }, from: 'worker', seq: 1 });

  const result = appendSyntheticIfAbsent(outbox, {
    type: 'result',
    body: { summary: 'synthetic', verdict: 'blocked', paths: [] },
    from: 'wrapper',
  });

  expect(result).toBeNull();
  const lines = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim());
  expect(lines.length).toBe(1);
});

test('appendSyntheticIfAbsent: assigns a valid seq number', () => {
  const outbox = makeOutbox(tmpDir);

  const result = appendSyntheticIfAbsent(outbox, {
    type: 'result',
    body: { summary: 'test', verdict: 'blocked', paths: [] },
    from: 'wrapper',
  });

  expect(result).not.toBeNull();
  expect(typeof result.seq).toBe('number');
  expect(result.seq).toBeGreaterThan(0);
});

// ── ensure-result CLI ─────────────────────────────────────────────────────────

test('ensure-result CLI: appends synthetic result to empty outbox', () => {
  const outbox = makeOutbox(tmpDir);

  const r = spawnSync('bun', [CHANNEL_JS, 'ensure-result', '--file', outbox, '--exit-code', '1', '--from', 'wrapper', '--quiet'], {
    encoding: 'utf8',
  });

  expect(r.status).toBe(0);
  const msgs = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  expect(msgs.length).toBe(1);
  expect(msgs[0].type).toBe('result');
  expect(msgs[0].body.verdict).toBe('blocked');
  expect(msgs[0].body.summary).toContain('exit_code=1');
});

test('ensure-result CLI: includes signal in summary when provided', () => {
  const outbox = makeOutbox(tmpDir);

  spawnSync('bun', [CHANNEL_JS, 'ensure-result', '--file', outbox, '--exit-code', '137', '--signal', '9', '--from', 'wrapper', '--quiet'], {
    encoding: 'utf8',
  });

  const msgs = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  expect(msgs[0].body.summary).toContain('signal=9');
});

test('ensure-result CLI: does not append duplicate when result already exists', () => {
  const outbox = makeOutbox(tmpDir);
  appendLine(outbox, { ts: 1, type: 'result', body: { summary: 'done', verdict: 'complete', paths: [] }, from: 'worker', seq: 1 });

  spawnSync('bun', [CHANNEL_JS, 'ensure-result', '--file', outbox, '--exit-code', '0', '--from', 'wrapper', '--quiet'], {
    encoding: 'utf8',
  });

  const lines = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim());
  expect(lines.length).toBe(1);
});

// ── advisor-observe exit codes ────────────────────────────────────────────────

test('advisor-observe exits 1 when result has verdict=blocked', () => {
  const sid = `silent-exit-test-${Date.now()}`;
  const home = tmpDir;
  const channelDir = path.join(home, '.advisor', 'runs', sid, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const outboxPath = path.join(channelDir, 'outbox.jsonl');
  fs.appendFileSync(outboxPath, JSON.stringify({ ts: 1, type: 'result', body: { summary: 'blocked', verdict: 'blocked', paths: [] }, from: 'wrapper', seq: 1 }) + '\n');

  const r = spawnSync('node', [ADVISOR_OBSERVE, sid, '--max-wait', '2'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 3000,
  });

  expect(r.status).toBe(1);
});

test('advisor-observe exits 0 when result has verdict=complete', () => {
  const sid = `silent-exit-test-${Date.now()}`;
  const home = tmpDir;
  const channelDir = path.join(home, '.advisor', 'runs', sid, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const outboxPath = path.join(channelDir, 'outbox.jsonl');
  fs.appendFileSync(outboxPath, JSON.stringify({ ts: 1, type: 'result', body: { summary: 'done', verdict: 'complete', paths: [] }, from: 'worker', seq: 1 }) + '\n');

  const r = spawnSync('node', [ADVISOR_OBSERVE, sid, '--max-wait', '2'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 3000,
  });

  expect(r.status).toBe(0);
});

test('advisor-observe exits 0 for legacy string body (non-object)', () => {
  const sid = `silent-exit-test-${Date.now()}`;
  const home = tmpDir;
  const channelDir = path.join(home, '.advisor', 'runs', sid, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const outboxPath = path.join(channelDir, 'outbox.jsonl');
  fs.appendFileSync(outboxPath, JSON.stringify({ ts: 1, type: 'result', body: 'plain string result', from: 'worker', seq: 1 }) + '\n');

  const r = spawnSync('node', [ADVISOR_OBSERVE, sid, '--max-wait', '2'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 3000,
  });

  expect(r.status).toBe(0);
});

// ── launch.sh silent-exit simulation (end-to-end) ────────────────────────────

test('launch.sh pattern: ensure-result seals outbox after silent worker exit', () => {
  const outbox = makeOutbox(tmpDir);

  // Worker writes progress but never result (simulates silent crash)
  appendLine(outbox, { ts: 1, type: 'progress', body: 'started', from: 'worker', seq: 1 });

  // Wrapper runs ensure-result after claude exits (as the fixed launch.sh does)
  const r = spawnSync('bun', [CHANNEL_JS, 'ensure-result', '--file', outbox, '--exit-code', '1', '--from', 'wrapper', '--quiet'], {
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);

  const msgs = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const resultMsgs = msgs.filter(m => m.type === 'result');
  expect(resultMsgs.length).toBe(1);
  expect(resultMsgs[0].body.verdict).toBe('blocked');
  expect(resultMsgs[0].body.summary).toContain('worker exited without result');
  expect(resultMsgs[0].body.summary).toContain('exit_code=1');
});

test('launch.sh pattern: no duplicate when worker already wrote result', () => {
  const outbox = makeOutbox(tmpDir);

  appendLine(outbox, { ts: 1, type: 'progress', body: 'working', from: 'worker', seq: 1 });
  appendLine(outbox, { ts: 2, type: 'result', body: { summary: 'done', verdict: 'complete', paths: ['/output/changes.md'] }, from: 'worker', seq: 2 });

  // Wrapper runs ensure-result (should be a no-op)
  spawnSync('bun', [CHANNEL_JS, 'ensure-result', '--file', outbox, '--exit-code', '0', '--from', 'wrapper', '--quiet'], {
    encoding: 'utf8',
  });

  const msgs = fs.readFileSync(outbox, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const resultMsgs = msgs.filter(m => m.type === 'result');
  expect(resultMsgs.length).toBe(1);
  expect(resultMsgs[0].from).toBe('worker');
  expect(resultMsgs[0].body.verdict).toBe('complete');
});

// ── summon.js and tmux-runner.js structural checks ──────────────────────────

test('summon.js: launch.sh template uses ensure-result (not bare exec of claude)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../lib/summon.js'), 'utf8');
  expect(src).toContain('ensure-result');
  // Must NOT have 'exec' immediately before the claude invocation
  expect(src).not.toMatch(/`exec \$\{claudeCore/);
});

test('tmux-runner.js: references appendSyntheticIfAbsent for outbox sealing', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../lib/tmux-runner.js'), 'utf8');
  expect(src).toContain('appendSyntheticIfAbsent');
});

test('tmux-runner.js: handles timeout and pane-died reasons', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../lib/tmux-runner.js'), 'utf8');
  expect(src).toContain('timeout');
  expect(src).toContain('pane-died');
  expect(src).toContain('stop-hook-but-no-result');
});
