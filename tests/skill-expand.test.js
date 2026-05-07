import { test, expect } from 'bun:test';

// U3 Phase 5 Wave 1: lib/skill-expand.js does not exist yet.
// All tests fail on import with module-not-found — that IS the red signal.

import { expandSkillContent } from '../lib/skill-expand.js';

test('expandSkillContent is a named export and is a function that returns a string', () => {
  expect(typeof expandSkillContent).toBe('function');
  const result = expandSkillContent('probe');
  expect(typeof result).toBe('string');
  expect(result instanceof Promise).toBe(false);
});

test('expandSkillContent returns input unchanged when no shell substitutions present', () => {
  expect(expandSkillContent('no expansions here')).toBe('no expansions here');
});

test('expandSkillContent expands a single $(…) shell substitution', () => {
  expect(expandSkillContent('prefix $(echo hello) suffix')).toBe('prefix hello suffix');
});

test('expandSkillContent truncates output longer than 4000 chars', () => {
  const result = expandSkillContent('$(printf %4001s x)');
  expect(result.length).toBeLessThanOrEqual(4000);
});

test('expandSkillContent returns a string containing "timed out" for long-running commands', { timeout: 20000 }, () => {
  const result = expandSkillContent('$(sleep 20)');
  expect(typeof result).toBe('string');
  expect(result).toContain('timed out');
});

test('expandSkillContent expands multiple $(…) substitutions in one string', () => {
  expect(expandSkillContent('$(echo a) and $(echo b)')).toBe('a and b');
});
