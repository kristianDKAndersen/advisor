// Regression test for H1: parseFrontmatter reads from spawns/ not agents/.
// Verifies that a real agent (researcher) has non-empty default_tools,
// proving the spawns/ path resolves correctly from ADVISOR_ROOT.

import { test, expect } from 'bun:test';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agents = require('../lib/agents');

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');

test('parseFrontmatter resolves researcher CLAUDE.md via spawns/', () => {
  const claudeMdPath = path.join(ADVISOR_ROOT, 'spawns', 'researcher', 'CLAUDE.md');
  const fm = agents.parseFrontmatter(claudeMdPath);
  expect(Array.isArray(fm.default_tools)).toBe(true);
  expect(fm.default_tools.length).toBeGreaterThan(0);
});

test('parseFrontmatter returns default_tools containing Read for researcher', () => {
  const claudeMdPath = path.join(ADVISOR_ROOT, 'spawns', 'researcher', 'CLAUDE.md');
  const fm = agents.parseFrontmatter(claudeMdPath);
  expect(fm.default_tools).toContain('Read');
});
