import { test, expect } from 'bun:test';

// Tests for lib/summon.js --protected-tests flag.
// We test the pure buildProtectedTestsEnv helper, which extracts the env-assembly
// logic so it can be verified without spawning a full session.

const { buildProtectedTestsEnv } = await import('../lib/summon.js');

test('buildProtectedTestsEnv returns ADVISOR_PROTECTED_TESTS as JSON array when paths provided', () => {
  const result = buildProtectedTestsEnv(['/a/b/test.js', '/c/d/spec.js']);
  expect(result).toHaveProperty('ADVISOR_PROTECTED_TESTS');
  const parsed = JSON.parse(result.ADVISOR_PROTECTED_TESTS);
  expect(parsed).toEqual(['/a/b/test.js', '/c/d/spec.js']);
});

test('buildProtectedTestsEnv returns empty object when no paths provided', () => {
  expect(buildProtectedTestsEnv(null)).toEqual({});
  expect(buildProtectedTestsEnv(undefined)).toEqual({});
  expect(buildProtectedTestsEnv([])).toEqual({});
});

test('ADVISOR_PROTECTED_TESTS key is absent from buildProtectedTestsEnv({}) result', () => {
  const result = buildProtectedTestsEnv([]);
  expect(Object.keys(result)).not.toContain('ADVISOR_PROTECTED_TESTS');
});
