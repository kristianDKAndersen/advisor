import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');

// U1: The seq lock must cover the appendFileSync call.
// Bug: acquireSeqLock releases the lock (rmdirSync) inside its own finally{} before returning
// the seq number, so append() calls appendFileSync AFTER the lock is gone.
// Fix: appendFileSync must be called before rmdirSync — inside acquireSeqLock's critical section.

test('acquireSeqLock body contains appendFileSync before rmdirSync (lock held during write)', () => {
  const src = fs.readFileSync(CHANNEL_JS, 'utf8');

  // Extract acquireSeqLock function body.
  // Match from function declaration to the first top-level closing brace.
  const match = src.match(/function acquireSeqLock\b[\s\S]*?^\}/m);
  expect(match).not.toBeNull();
  const acquireBody = match[0];

  const appendFsPos = acquireBody.indexOf('appendFileSync');
  const rmdirPos = acquireBody.indexOf('rmdirSync');

  // appendFileSync must appear INSIDE acquireSeqLock (not after it returns in append()).
  // Currently appendFileSync is only called in append(), outside acquireSeqLock → appendFsPos === -1.
  expect(appendFsPos).toBeGreaterThanOrEqual(0);

  // appendFileSync must appear BEFORE rmdirSync (lock held during the write).
  expect(appendFsPos).toBeLessThan(rmdirPos);
});
