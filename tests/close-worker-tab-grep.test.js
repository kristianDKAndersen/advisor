// Structural source-text tests for bin/close-worker-tab grep and ps-loop fixes.
// W2: grep should use -F exact match instead of fuzzy regex suffix.
// W3: ps block should use single awk+xargs instead of per-line subprocess loop.
import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = fs.readFileSync(path.join(ADVISOR_ROOT, 'bin', 'close-worker-tab'), 'utf8');

test('[W2] close-worker-tab uses grep -F exact match instead of fuzzy regex suffix', () => {
  expect(SCRIPT).not.toContain('grep " .*${sid}"');
  expect(SCRIPT).toContain('grep -F " ${sid}"');
});

test('[W3] close-worker-tab uses single awk+xargs instead of per-line subprocess loop', () => {
  expect(SCRIPT).not.toContain('while IFS= read -r line');
  expect(SCRIPT).toContain('awk -v sid="$sid"');
});
