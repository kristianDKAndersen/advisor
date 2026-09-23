import { test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pollSentinel } from '../lib/tmux-runner.js';

// ── pollSentinel must not wait out the full timeout once the pane/session is gone ──
test('pollSentinel: exits promptly (within ~one poll interval) when checkAlive throws twice in a row', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid.done');
  // Sentinel never appears — simulates a killed pane that will never finish.
  const checkAlive = () => { throw new Error('tmux: session not found'); };

  const start = Date.now();
  // Shortened checkAliveIntervalMs (6th arg) so 2 consecutive failures land quickly in a test.
  const done = await pollSentinel(sentinel, 60_000, 50, tmpDir, checkAlive, 10);
  const elapsed = Date.now() - start;

  expect(done).toBe(false);
  expect(elapsed).toBeLessThan(1000); // far under the 60s timeout
});

test('pollSentinel: one transient checkAlive failure does not abort the poll', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid-transient.done');
  let calls = 0;
  const checkAlive = () => {
    calls += 1;
    if (calls === 1) throw new Error('tmux: transient hiccup');
    // succeeds on every subsequent call, resetting the failure count.
  };

  const done = await pollSentinel(sentinel, 250, 20, tmpDir, checkAlive, 10);

  expect(done).toBe(false); // sentinel never appears, but not because checkAlive aborted it
  expect(calls).toBeGreaterThan(1); // polling continued past the single transient failure
});

test('pollSentinel: two consecutive checkAlive failures abort promptly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid-two-fail.done');
  const checkAlive = () => { throw new Error('tmux: session not found'); };

  const start = Date.now();
  const done = await pollSentinel(sentinel, 60_000, 20, tmpDir, checkAlive, 10);
  const elapsed = Date.now() - start;

  expect(done).toBe(false);
  expect(elapsed).toBeLessThan(1000);
});

test('pollSentinel: checkAlive probe frequency is bounded by the throttle interval', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid-throttle.done');
  let calls = 0;
  const checkAlive = () => { calls += 1; };

  // Poll ticks every 10ms for ~300ms, but checkAlive throttled to every 100ms.
  await pollSentinel(sentinel, 300, 10, tmpDir, checkAlive, 100);

  // Without throttling this would be ~30 calls; with it, ~3-4.
  expect(calls).toBeLessThanOrEqual(6);
});

test('pollSentinel: still waits out the full loop when checkAlive keeps succeeding and sentinel never appears', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid-2.done');
  const checkAlive = () => {}; // pane alive throughout

  const start = Date.now();
  const done = await pollSentinel(sentinel, 200, 50, tmpDir, checkAlive);
  const elapsed = Date.now() - start;

  expect(done).toBe(false);
  expect(elapsed).toBeGreaterThanOrEqual(150);
});

test('pollSentinel: succeeds normally when the sentinel appears before any death is detected', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid-3.done');
  fs.writeFileSync(sentinel + '.json', JSON.stringify({ cwd: tmpDir }));
  fs.writeFileSync(sentinel, '');
  const checkAlive = () => {};

  const done = await pollSentinel(sentinel, 1000, 50, tmpDir, checkAlive);
  expect(done).toBe(true);
});
