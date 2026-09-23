import { test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pollSentinel } from '../lib/tmux-runner.js';

// ── pollSentinel must not wait out the full timeout once the pane/session is gone ──
test('pollSentinel: exits promptly (within ~one poll interval) when checkAlive throws', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollsentinel-liveness-'));
  const sentinel = path.join(tmpDir, 'fake-sid.done');
  // Sentinel never appears — simulates a killed pane that will never finish.
  const checkAlive = () => { throw new Error('tmux: session not found'); };

  const start = Date.now();
  const done = await pollSentinel(sentinel, 60_000, 50, tmpDir, checkAlive);
  const elapsed = Date.now() - start;

  expect(done).toBe(false);
  expect(elapsed).toBeLessThan(1000); // far under the 60s timeout
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
