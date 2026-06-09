import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-readafter-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: cursor-efficient read — second call returns only new messages ─────
// RED: readAfterFast is not yet exported, import resolves to undefined → throws.
test('readAfterFast: does not re-read bytes before the offset after first call', async () => {
  const { append, readAfterFast, Tail } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'fast1.jsonl');

  // Write 10 messages
  for (let i = 0; i < 10; i++) {
    append(file, { type: 'test', body: `msg-${i}` });
  }

  const t = new Tail();
  // First call reads all 10
  const first = readAfterFast(file, 0, t);
  expect(first.length).toBe(10);

  // Append 3 more
  for (let i = 10; i < 13; i++) {
    append(file, { type: 'test', body: `msg-${i}` });
  }

  // Second call must return ONLY the 3 new messages (cursor skips first 10)
  const second = readAfterFast(file, 0, t);
  expect(second.length).toBe(3);
});

// ── Test 2: returns empty array when no new messages since last call ──────────
test('readAfterFast: returns empty array when no new messages since last call', async () => {
  const { append, readAfterFast, Tail } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'fast2.jsonl');
  append(file, { type: 'test', body: 'only' });

  const t = new Tail();
  readAfterFast(file, 0, t); // first call sets offset to end

  // Second call with no new messages
  const result = readAfterFast(file, 0, t);
  expect(result.length).toBe(0);
});
