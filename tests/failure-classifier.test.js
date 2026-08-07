// tests/failure-classifier.test.js
const { test, expect, describe } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifySessionDir, classifyPaneDeath } = require('../lib/failure-classifier');

function makeSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'failure-classifier-'));
}

function writeOutbox(dir, lines) {
  fs.mkdirSync(path.join(dir, 'channel'), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'channel', 'outbox.jsonl'), body);
}

function writeTmuxLog(dir, content) {
  fs.writeFileSync(path.join(dir, 'tmux-runner.log'), content);
}

describe('classifySessionDir', () => {
  test('TRANSIENT pane-death: tmux infra race in tmux-runner.log', () => {
    const dir = makeSessionDir();
    writeTmuxLog(dir, 'some boot lines\nCommand failed: tmux pipe-pane -t %3\nmore lines\n');
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=unknown); reason=pane-died', verdict: 'blocked', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('pane-death');
    expect(v.transient).toBe(true);
    expect(v.evidence).toMatch(/tmux-runner\.log/);
    expect(v.evidence).toMatch(/Command failed/);
  });

  test('DETERMINISTIC pane-death: exit_code=137 (SIGKILL/OOM)', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=137, signal=SIGKILL); reason=pane-died', verdict: 'blocked', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('pane-death');
    expect(v.transient).toBe(false);
    expect(v.evidence).toMatch(/exit_code=137/);
  });

  test('exit_code=143 (SIGTERM) is resolved by accompanying reason, not treated as a bare crash', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=143); reason=timeout', verdict: 'blocked', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('hit-timeout');
    expect(v.transient).toBe(false);
  });

  test('hit-timeout: reason=timeout in outbox', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=unknown); reason=timeout', verdict: 'blocked', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('hit-timeout');
    expect(v.transient).toBe(false);
    expect(v.evidence).toMatch(/reason=timeout/);
  });

  test('hit-timeout: tmux-runner.log spawnHeadless timeout marker, no outbox result', () => {
    const dir = makeSessionDir();
    writeTmuxLog(dir, 'booting\nspawnHeadless timed out after 300000ms (sid=abc, pane=%1, reason=timeout)\n');
    writeOutbox(dir, [
      { seq: 1, type: 'progress', from: 'coder', body: 'working on it' },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('hit-timeout');
    expect(v.transient).toBe(false);
    expect(v.evidence).toMatch(/spawnHeadless timed out after/);
  });

  test('launch-death: outbox is zero bytes', () => {
    const dir = makeSessionDir();
    fs.mkdirSync(path.join(dir, 'channel'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'channel', 'outbox.jsonl'), '');
    const v = classifySessionDir(dir);
    expect(v.category).toBe('launch-death');
    expect(v.transient).toBe(false);
  });

  test('launch-death: outbox missing entirely', () => {
    const dir = makeSessionDir();
    const v = classifySessionDir(dir);
    expect(v.category).toBe('launch-death');
    expect(v.transient).toBe(false);
    expect(v.evidence).toBeTruthy();
  });

  test('launch-death: tmux infra race with no outbox at all is transient', () => {
    const dir = makeSessionDir();
    writeTmuxLog(dir, 'Command failed: tmux new-session -d -s foo\n');
    const v = classifySessionDir(dir);
    expect(v.category).toBe('launch-death');
    expect(v.transient).toBe(true);
    expect(v.evidence).toMatch(/Command failed/);
  });

  test('api-stall: progress message present, no result, no timeout/pane-died markers', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'progress', from: 'coder', body: 'Understood, starting work' },
      { seq: 2, type: 'question', from: 'coder', body: 'Which branch should I use?' },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('api-stall');
    expect(v.transient).toBe(false);
  });

  test('clean-result: genuine result verdict=complete', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'progress', from: 'coder', body: 'starting' },
      { seq: 2, type: 'result', from: 'coder', body: { summary: 'Applied all fixes', verdict: 'complete', paths: ['/x/changes.md'] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('clean-result');
    expect(v.transient).toBe(null);
  });

  test('clean-result: genuine result verdict=partial', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'coder', body: { summary: 'Applied 3/5 fixes', verdict: 'partial', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('clean-result');
    expect(v.transient).toBe(null);
  });

  test('blocked: genuine worker-authored result verdict=blocked', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'progress', from: 'coder', body: 'starting' },
      { seq: 2, type: 'result', from: 'coder', body: { summary: 'Cannot satisfy spec assertion X', verdict: 'blocked', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('blocked');
    expect(v.transient).toBe(null);
  });

  test('genuine result arriving after a racey synthetic no-op-success marker wins (last-result semantics)', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=unknown); reason=no-op-success', verdict: 'blocked', paths: [] } },
      { seq: 2, type: 'result', from: 'coder', body: { summary: 'Applied all fixes', verdict: 'complete', paths: [] } },
    ]);
    const v = classifySessionDir(dir);
    expect(v.category).toBe('clean-result');
    expect(v.transient).toBe(null);
  });

  test('unrecognised/empty session directory defaults to transient:false with explanatory evidence', () => {
    const dir = makeSessionDir();
    const v = classifySessionDir(dir);
    expect(v.transient).toBe(false);
    expect(typeof v.evidence).toBe('string');
    expect(v.evidence.length).toBeGreaterThan(0);
  });
});

describe('classifyPaneDeath adapter (lib/loop-termination.js options.classifyPaneDeath seam)', () => {
  test('returns "transient" for a round pointing at a transient pane-death session dir', () => {
    const dir = makeSessionDir();
    writeTmuxLog(dir, 'Command failed: tmux pipe-pane -t %3\n');
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=unknown); reason=pane-died', verdict: 'blocked', paths: [] } },
    ]);
    expect(classifyPaneDeath({ session_dir: dir })).toBe('transient');
  });

  test('returns "deterministic" for a round pointing at exit_code=137', () => {
    const dir = makeSessionDir();
    writeOutbox(dir, [
      { seq: 1, type: 'result', from: 'wrapper', body: { summary: 'worker exited without result (exit_code=137, signal=SIGKILL); reason=pane-died', verdict: 'blocked', paths: [] } },
    ]);
    expect(classifyPaneDeath({ session_dir: dir })).toBe('deterministic');
  });

  test('returns "deterministic" when round has no session_dir', () => {
    expect(classifyPaneDeath({})).toBe('deterministic');
    expect(classifyPaneDeath(null)).toBe('deterministic');
  });
});
