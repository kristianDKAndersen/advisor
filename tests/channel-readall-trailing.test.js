import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-readall-'));

// ── a trailing unterminated line must not warn, and earlier records still return ──
test('readAll: trailing unterminated line emits no warning, earlier records still returned', async () => {
  const { readAll } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'trailing.jsonl');
  fs.writeFileSync(file, '{"seq":1,"type":"progress"}\n{"seq":2,"ty');

  const origWrite = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk, ...rest) => { warnings.push(String(chunk)); return true; };
  let result;
  try {
    result = readAll(file);
  } finally {
    process.stderr.write = origWrite;
  }

  expect(warnings.length).toBe(0);
  expect(result.length).toBe(1);
  expect(result[0].seq).toBe(1);
});

// ── a complete corrupt line in the MIDDLE of the file must still warn ─────────────
test('readAll: a complete corrupt line mid-file still emits the malformed-line warning', async () => {
  const { readAll } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'midcorrupt.jsonl');
  fs.writeFileSync(file, '{"seq":1,"type":"progress"}\nnot valid json\n{"seq":3,"type":"progress"}\n');

  const origWrite = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk, ...rest) => { warnings.push(String(chunk)); return true; };
  let result;
  try {
    result = readAll(file);
  } finally {
    process.stderr.write = origWrite;
  }

  expect(warnings.some(w => w.includes('skipping malformed line'))).toBe(true);
  expect(result.length).toBe(2);
  expect(result.map(m => m.seq)).toEqual([1, 3]);
});

// ── Tail behavior must be unchanged by this fix ───────────────────────────────────
test('Tail.read: still emits no warning on a trailing unterminated line (unchanged)', async () => {
  const { Tail } = await import(LIB_CHANNEL);

  const file = path.join(tmpDir, 'tail-unchanged.jsonl');
  fs.writeFileSync(file, '{"seq":1,"type":"progress"}\n{"seq":2,"ty');

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

  expect(warnings.length).toBe(0);
  expect(result.length).toBe(1);
  expect(result[0].seq).toBe(1);
});
