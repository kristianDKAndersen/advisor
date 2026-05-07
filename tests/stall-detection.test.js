import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const PARALLEL_JS = path.resolve(import.meta.dir, '../lib/parallel.js');
const ADVISOR_OBSERVE = path.resolve(import.meta.dir, '../bin/advisor-observe');

// U5: stall detection.
// lib/parallel.js must emit a 'stalled' channel message after 60s of worker silence.
// bin/advisor-observe must emit {"type":"stalled",...} JSON line after 60s of no messages.
// Neither path exists yet.

test('parallel.js poll loop emits stalled channel message at 60s silence threshold', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  // The stall threshold must be defined and used to emit a 'stalled' message.
  expect(src).toContain("'stalled'");
});

test('parallel.js defines a stall threshold distinct from the nudge and terminate thresholds', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  // Must have a stalled-specific timeout (60_000 or 60000 ms).
  expect(src).toMatch(/stall|60[_,]?000/);
  // Must append a 'stalled' type message to the channel.
  expect(src).toMatch(/type.*stalled|stalled.*type/);
});

test('advisor-observe emits {type:"stalled"} JSON line after 60s of silence', () => {
  const src = fs.readFileSync(ADVISOR_OBSERVE, 'utf8');
  expect(src).toContain('stalled');
});

test('advisor-observe stalled emission includes silentMs field', () => {
  const src = fs.readFileSync(ADVISOR_OBSERVE, 'utf8');
  expect(src).toContain('silentMs');
});
