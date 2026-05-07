import { test, expect } from 'bun:test';

// U4: lib/tool-guard.js does not exist yet.
// All tests in this file will fail on import with module-not-found — that IS the red signal.

import {
  canonicalHash,
  checkDuplicate,
  resetState,
} from '../lib/tool-guard.js';

test('canonicalHash returns a stable SHA256 hex string for the same args', () => {
  const h1 = canonicalHash('Bash', { command: 'ls -la' });
  const h2 = canonicalHash('Bash', { command: 'ls -la' });
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
});

test('canonicalHash returns different hashes for different args', () => {
  const h1 = canonicalHash('Bash', { command: 'ls' });
  const h2 = canonicalHash('Bash', { command: 'pwd' });
  expect(h1).not.toBe(h2);
});

test('checkDuplicate returns false on first call for a unique hash', () => {
  resetState();
  const result = checkDuplicate('Bash', { command: 'echo unique-1' });
  expect(result.duplicate).toBe(false);
  expect(result.count).toBe(1);
});

test('checkDuplicate returns true after N=3 identical calls and signals halt', () => {
  resetState();
  const args = { command: 'echo dedup-test' };
  checkDuplicate('Bash', args); // 1
  checkDuplicate('Bash', args); // 2
  const third = checkDuplicate('Bash', args); // 3
  expect(third.duplicate).toBe(true);
  expect(third.halt).toBe(true);
  expect(third.count).toBe(3);
});

test('checkDuplicate counts are per tool+args combination, not global', () => {
  resetState();
  checkDuplicate('Bash', { command: 'echo a' });
  checkDuplicate('Bash', { command: 'echo a' });
  const other = checkDuplicate('Read', { file_path: '/tmp/foo' });
  expect(other.count).toBe(1);
  expect(other.halt).toBeFalsy();
});
