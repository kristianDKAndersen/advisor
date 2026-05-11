import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// W4 — RED tests for lib/terminal-persist.js (does not exist yet).
// Import will fail with "Cannot find module" until lib/terminal-persist.js is created.

import { persistTerminal, loadTerminal } from '../lib/terminal-persist.js';

// --- tmp fixture setup ---

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-persist-test-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeTmpDir(suffix) {
  const d = path.join(tmpRoot, suffix);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// --- tests ---

test('round-trip: persistTerminal then loadTerminal returns the same payload', () => {
  const channelDir = makeTmpDir('round-trip');
  const payload = { seq: 42, type: 'result', body: 'done' };
  persistTerminal(channelDir, payload);
  const loaded = loadTerminal(channelDir);
  expect(loaded).toEqual(payload);
});

test('atomic: 5 concurrent persists to same dir yield clean JSON (no torn write)', async () => {
  const channelDir = makeTmpDir('atomic');
  const payloads = [
    { seq: 1, type: 'result', body: 'a' },
    { seq: 2, type: 'result', body: 'b' },
    { seq: 3, type: 'result', body: 'c' },
    { seq: 4, type: 'result', body: 'd' },
    { seq: 5, type: 'result', body: 'e' },
  ];
  await Promise.all(payloads.map(p => Promise.resolve(persistTerminal(channelDir, p))));
  const loaded = loadTerminal(channelDir);
  // must be one of the payloads — not null, not torn JSON
  expect(loaded).not.toBeNull();
  expect(typeof loaded).toBe('object');
  expect(typeof loaded.seq).toBe('number');
  expect(loaded.type).toBe('result');
  expect(typeof loaded.body).toBe('string');
  // must be exactly one of the five payloads
  const seqs = payloads.map(p => p.seq);
  expect(seqs).toContain(loaded.seq);
});

test('loadTerminal returns null for missing file', () => {
  const channelDir = makeTmpDir('missing');
  const result = loadTerminal(channelDir);
  expect(result).toBeNull();
});

test('loadTerminal returns null for corrupt file', () => {
  const channelDir = makeTmpDir('corrupt');
  fs.writeFileSync(path.join(channelDir, 'terminal.json'), 'not json', 'utf8');
  const result = loadTerminal(channelDir);
  expect(result).toBeNull();
});

test('persistTerminal on non-existent channelDir does not throw', () => {
  const nonExistent = path.join(tmpRoot, 'does-not-exist');
  expect(() => persistTerminal(nonExistent, { seq: 1 })).not.toThrow();
});

test('loadTerminal on non-existent channelDir returns null', () => {
  const nonExistent = path.join(tmpRoot, 'also-does-not-exist');
  expect(loadTerminal(nonExistent)).toBeNull();
});

test('.tmp file is cleaned up after successful persist', () => {
  const channelDir = makeTmpDir('cleanup');
  persistTerminal(channelDir, { seq: 99, type: 'result', body: 'ok' });
  const tmpFile = path.join(channelDir, 'terminal.json.tmp');
  expect(fs.existsSync(tmpFile)).toBe(false);
});
