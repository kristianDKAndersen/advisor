import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');
const LIB_TMUX = path.resolve(import.meta.dir, '../lib/tmux-runner.js');
const LIB_COMPACTOR = path.resolve(import.meta.dir, '../lib/compactor.js');

const ch = require(LIB_CHANNEL);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-lock-'));
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// Mark a lock dir as stale by back-dating its mtime well past the 10s threshold.
function staleLock(lockDir) {
  fs.mkdirSync(lockDir);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);
}

// W1 — acquireSeqLock must recover from a stale .seq.lock left by a killed worker.
test('W1: acquireSeqLock recovers stale .seq.lock and assigns seq', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'acq-'));
  const file = path.join(dir, 'outbox.jsonl');
  fs.writeFileSync(file, '');
  staleLock(path.join(dir, '.seq.lock'));

  const payload = ch.acquireSeqLock(dir, file, { type: 'task', from: 'x' });
  expect(payload.seq).toBe(1);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  expect(JSON.parse(lines[0]).seq).toBe(1);
});

// W1 — the embedded lock inside appendSyntheticIfAbsent has the same gap.
test('W1: appendSyntheticIfAbsent recovers stale .seq.lock and appends result', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'syn-'));
  const file = path.join(dir, 'outbox.jsonl');
  fs.writeFileSync(file, '');
  staleLock(path.join(dir, '.seq.lock'));

  const payload = ch.appendSyntheticIfAbsent(file, { type: 'result', body: 'synthetic', from: 'x' });
  expect(payload).not.toBeNull();
  expect(payload.seq).toBe(1);
});

// N3 — withTuiLock must carry the same stale-lock recovery (source-pattern).
test('N3: withTuiLock body contains stale-lock recovery', () => {
  const src = fs.readFileSync(LIB_TMUX, 'utf8');
  const match = src.match(/function withTuiLock\b[\s\S]*?\n\}/m);
  expect(match).not.toBeNull();
  const body = match[0];
  expect(body).toContain('statSync');
  expect(body).toContain('mtimeMs');
  expect(body).toContain('rmdirSync');
});

// W2 — compactor must write transcript_path atomically via tmp + renameSync.
test('W2: compactor writes transcript atomically (tmp + renameSync)', () => {
  const src = fs.readFileSync(LIB_COMPACTOR, 'utf8');
  // No direct non-atomic write to the live transcript path.
  expect(src).not.toMatch(/fs\.writeFileSync\(\s*transcript_path\s*,/);
  expect(src).toContain("transcript_path + '.tmp'");
  expect(src).toMatch(/fs\.renameSync\([^)]*transcript_path/);
});

// W3 — legacy headless happy path must seal with 'no-op-success', not 'stop-hook-but-no-result'.
test("W3: legacy headless happy path seals outbox with 'no-op-success'", () => {
  const src = fs.readFileSync(LIB_TMUX, 'utf8');
  const happyPaths = src.match(/Happy path: worker wrote its own result; sealOutbox is a no-op in that case\.\s*\n\s*sealOutbox\('([^']+)'\)/g) || [];
  expect(happyPaths.length).toBe(2);
  for (const hp of happyPaths) {
    expect(hp).toContain("sealOutbox('no-op-success')");
  }
});
