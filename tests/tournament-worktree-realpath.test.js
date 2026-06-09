import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

// W4: bin/tournament must resolve /tmp through fs.realpathSync.native before
// constructing the worktree path, so on macOS (where /tmp → /private/tmp) the
// path stored in createdWorktrees matches what git actually registers.

test('W4: bin/tournament does not use hardcoded /tmp/tournament- in wtPath template literal', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../bin/tournament'), 'utf8');
  // Pre-fix: wtPath was constructed with bare `/tmp/tournament-${runId}-${strategy}`
  expect(src).not.toContain('`/tmp/tournament-${runId}-${strategy}`');
});

test('W4: bin/tournament uses fs.realpathSync to resolve /tmp before building wtPath', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../bin/tournament'), 'utf8');
  expect(src).toContain('realpathSync');
});
