import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const SKILL_MD = path.resolve(import.meta.dir, '../skills/worker-protocol/SKILL.md');

// U6: skills/worker-protocol/SKILL.md must contain the result-body-cap rule.
// The rule must specify: result body ≤ 3k tokens, sources ≤ 50 with 1-line summaries.
// Currently absent from SKILL.md.

test('SKILL.md exists and is readable', () => {
  expect(fs.existsSync(SKILL_MD)).toBe(true);
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  expect(content.length).toBeGreaterThan(0);
});

test('SKILL.md contains a result body token cap rule', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  // Must mention a token cap (3k or 3000 tokens) for the result body.
  expect(content).toMatch(/3[,_]?000\s*token|3k\s*token|token.*cap|cap.*token/i);
});

test('SKILL.md result cap rule specifies sources limit of 50', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  // Must mention a sources limit of 50.
  expect(content).toMatch(/source[s]?.*50|50.*source[s]?/i);
});

test('SKILL.md result cap rule requires 1-line summaries for sources', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  // Must mention 1-line summaries for source entries.
  expect(content).toMatch(/1.line\s+summar|one.line\s+summar/i);
});
