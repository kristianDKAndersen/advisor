import { test, expect, describe } from 'bun:test';

const { rewriteTestCommand } = require('../lib/tournament-rewrite');

describe('rewriteTestCommand — identity cases', () => {
  test('returns cmd unchanged when cmd is empty string', () => {
    expect(rewriteTestCommand('', '/from', '/to')).toBe('');
  });

  test('returns cmd unchanged when cmd is null', () => {
    expect(rewriteTestCommand(null, '/from', '/to')).toBeNull();
  });

  test('returns cmd unchanged when fromPath is null', () => {
    expect(rewriteTestCommand('bun test /some/path', null, '/to')).toBe('bun test /some/path');
  });

  test('returns cmd unchanged when fromPath is empty string (falsy)', () => {
    expect(rewriteTestCommand('bun test /some/path', '', '/to')).toBe('bun test /some/path');
  });
});

describe('rewriteTestCommand — substitution cases', () => {
  test('substitutes a single occurrence', () => {
    expect(rewriteTestCommand('bun test /from/foo.test.js', '/from', '/to'))
      .toBe('bun test /to/foo.test.js');
  });

  test('substitutes multiple occurrences in the same string', () => {
    expect(rewriteTestCommand('/from/a.test.js /from/b.test.js', '/from', '/to'))
      .toBe('/to/a.test.js /to/b.test.js');
  });

  test('realistic: rewrite spec-out path to tournament worktree path', () => {
    const cmd = 'bun test /tmp/spec-out/tests/bytes.test.js';
    const result = rewriteTestCommand(cmd, '/tmp/spec-out', '/tmp/tournament-run-minimal-diff');
    expect(result).toBe('bun test /tmp/tournament-run-minimal-diff/tests/bytes.test.js');
  });

  test('no-op when fromPath does not appear in cmd', () => {
    expect(rewriteTestCommand('bun test /other/path', '/from', '/to'))
      .toBe('bun test /other/path');
  });
});
