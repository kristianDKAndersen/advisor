import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

// W1: pipeline.js must maintain an advancing afterSeq cursor in the poll loop
// so previously-seen messages are not re-read on subsequent readAfter calls.
//
// Structural tests — verify the source contains the cursor-advancement pattern.
// These are reliable across isolated and combined bun test runs.

test('W1: pipeline.js passes afterSeq variable to readAfter (not hardcoded 0)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../lib/pipeline.js'), 'utf8');
  // Pre-fix: readAfter(outbox, 0) → this assertion fails
  expect(src).toContain('readAfter(outbox, afterSeq)');
  // Confirm the old hardcoded call is gone
  expect(src).not.toContain('readAfter(outbox, 0)');
});

test('W1: pipeline.js advances afterSeq using Math.max over message seq fields', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../lib/pipeline.js'), 'utf8');
  expect(src).toContain('let afterSeq = 0');
  expect(src).toContain('Math.max(afterSeq');
  expect(src).toContain('m.seq ?? 0');
});
