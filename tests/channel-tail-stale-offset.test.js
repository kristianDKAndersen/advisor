import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-tail-stale-'));

function captureStderr(fn) {
  const origWrite = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk, ...rest) => { warnings.push(String(chunk)); return true; };
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    process.stderr.write = origWrite;
  }
}

// ── split-write regression (the audit's lead hypothesis): passes unfixed too ──
test('Tail.read: a JSON line written in two chunks emits no warning and exactly one message', async () => {
  const { Tail } = await import(LIB_CHANNEL);
  const file = path.join(tmpDir, 'split-write.jsonl');
  fs.writeFileSync(file, '');

  const full = JSON.stringify({ ts: 1, type: 'task', body: 'x'.repeat(4000), from: 'advisor', seq: 1 });
  const half = full.slice(0, Math.floor(full.length / 2));
  const rest = full.slice(Math.floor(full.length / 2));

  const t = new Tail();
  fs.appendFileSync(file, half); // partial write, no trailing newline yet
  const { result: r1, warnings: w1 } = captureStderr(() => t.read(file));
  expect(w1.length).toBe(0);
  expect(r1.length).toBe(0);

  fs.appendFileSync(file, rest + '\n'); // completes the line
  const { result: r2, warnings: w2 } = captureStderr(() => t.read(file));
  expect(w2.length).toBe(0);
  expect(r2.length).toBe(1);
});

// ── the actual bug: a stale byte offset re-read against a rewritten file ──
// Tail tracks a byte offset per file. If the file is ever rewritten shorter-then-
// regrown (not pure-append), the old offset can land mid-line in the new content.
// This directly reproduces the audit's literal symptom: "skipping malformed line: }".
test('Tail.read: a stale offset against a rewritten file must not warn on a truncated fragment', async () => {
  const { Tail } = await import(LIB_CHANNEL);
  const file = path.join(tmpDir, 'rewritten.jsonl');

  const line1 = '{"seq":1,"type":"progress","body":"aaaa"}';
  fs.writeFileSync(file, line1 + '\n'); // length L

  const t = new Tail();
  const first = t.read(file);
  expect(first.length).toBe(1); // offset now sits at L (just past line1's newline)

  // Rewrite (not append) the file so that byte L-1 (old offset context) is now
  // the mid-point of an unrelated new line: "...}" followed immediately by a
  // real newline, then more content. Byte-for-byte crafted so the stale offset
  // does not fall on a line boundary.
  const line2 = '{"seq":2,"type":"progress","body":"bb"}';
  const line3 = '{"seq":3,"type":"progress","body":"cc"}';
  fs.writeFileSync(file, line2 + '\n' + line3 + '\n');

  const { result, warnings } = captureStderr(() => t.read(file));
  expect(warnings.some(w => w.includes('skipping malformed line: }'))).toBe(false);
  expect(result.map(m => m.seq)).toEqual([2, 3]);
});

// ── warning must name the file path and fire only once per malformed line ──
test('Tail.read: a genuinely malformed complete line warns once and names the file path', async () => {
  const { Tail } = await import(LIB_CHANNEL);
  const file = path.join(tmpDir, 'malformed.jsonl');
  fs.writeFileSync(file, 'not valid json\n');

  const t = new Tail();
  const { warnings: w1 } = captureStderr(() => t.read(file));
  expect(w1.length).toBe(1);
  expect(w1[0]).toContain(file);
  expect(w1[0]).toContain('skipping malformed line');

  fs.appendFileSync(file, '{"seq":2,"type":"progress"}\n');
  const { warnings: w2 } = captureStderr(() => t.read(file));
  expect(w2.length).toBe(0); // no duplicate warning for the already-seen malformed line
});
