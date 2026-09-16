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

// ── Test 3: a read landing mid-line must not warn, and must not drop the record ──
test('Tail.read: mid-line read emits no warning and returns the record complete on the following read', async () => {
  const { Tail } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'midline.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'test', body: 'first', seq: 1 }) + '\n');

  const t = new Tail();
  const firstBatch = t.read(file); // consumes the complete first line
  expect(firstBatch.length).toBe(1);

  // Simulate the writer being mid-append: a second record whose bytes are only
  // partially flushed (no trailing newline yet).
  const partial = '{"type":"test","body":"seco';
  fs.appendFileSync(file, partial);

  const origWrite = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk, ...rest) => { warnings.push(String(chunk)); return true; };
  let midRead;
  try {
    midRead = t.read(file);
  } finally {
    process.stderr.write = origWrite;
  }
  expect(midRead.length).toBe(0);
  expect(warnings.length).toBe(0);

  // Writer finishes flushing the record.
  fs.appendFileSync(file, 'nd"}\n');
  const finalRead = t.read(file);
  expect(finalRead.length).toBe(1);
  expect(finalRead[0].body).toBe('second');
});

// ── Test 4: a complete-but-corrupt line must still warn ───────────────────────
test('Tail.read: a complete corrupt line still emits the malformed-line warning', async () => {
  const { Tail } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'corrupt.jsonl');
  fs.writeFileSync(file, 'not valid json\n');

  const t = new Tail();
  const origWrite = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk, ...rest) => { warnings.push(String(chunk)); return true; };
  let result;
  try {
    result = t.read(file);
  } finally {
    process.stderr.write = origWrite;
  }
  expect(result.length).toBe(0);
  expect(warnings.some(w => w.includes('skipping malformed line'))).toBe(true);
});
