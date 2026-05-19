import { test, expect, describe } from 'bun:test';

// Regression test for spec self-check exit code path (commit 9e72c7d).
// bin/tournament exits 5 when the spec agent returns verdict='blocked'.
// We test the extracted pure function handleSpecVerdict() from lib/tournament-verdict.js
// which drives that decision without side effects.

const { handleSpecVerdict } = require('../lib/tournament-verdict');

describe('handleSpecVerdict — spec self-check exit-5 path (verdict=blocked)', () => {
  test('blocked verdict returns exitCode 5', () => {
    const result = handleSpecVerdict({ verdict: 'blocked', summary: 'spec inconsistency' });
    expect(result.exitCode).toBe(5);
  });

  test('blocked verdict message mentions blocked/inconsistency', () => {
    const result = handleSpecVerdict({ verdict: 'blocked', summary: 'x' });
    expect(result.message).toMatch(/blocked|inconsistency/i);
  });
});

describe('handleSpecVerdict — complete verdict (exitCode 0)', () => {
  test('complete with test_command returns exitCode 0', () => {
    const result = handleSpecVerdict({ verdict: 'complete', test_command: 'bun test' });
    expect(result.exitCode).toBe(0);
  });

  test('complete with test_command returns null message', () => {
    const result = handleSpecVerdict({ verdict: 'complete', test_command: 'bun test tests/' });
    expect(result.message).toBeNull();
  });
});

describe('handleSpecVerdict — complete verdict missing test_command (exitCode 2)', () => {
  test('complete without test_command returns exitCode 2', () => {
    const result = handleSpecVerdict({ verdict: 'complete' });
    expect(result.exitCode).toBe(2);
  });

  test('complete without test_command message mentions test_command', () => {
    const result = handleSpecVerdict({ verdict: 'complete' });
    expect(result.message).toContain('test_command');
  });
});

describe('handleSpecVerdict — partial verdict (exitCode 2)', () => {
  test('partial verdict returns exitCode 2', () => {
    const result = handleSpecVerdict({ verdict: 'partial', summary: 'half done' });
    expect(result.exitCode).toBe(2);
  });

  test('partial verdict message mentions the verdict string', () => {
    const result = handleSpecVerdict({ verdict: 'partial', summary: 'half done' });
    expect(result.message).toContain('partial');
  });
});

describe('handleSpecVerdict — invalid/missing input (exitCode 2)', () => {
  test('null input returns exitCode 2', () => {
    expect(handleSpecVerdict(null).exitCode).toBe(2);
  });

  test('undefined input returns exitCode 2', () => {
    expect(handleSpecVerdict(undefined).exitCode).toBe(2);
  });

  test('string input returns exitCode 2', () => {
    expect(handleSpecVerdict('blocked').exitCode).toBe(2);
  });

  test('array input returns exitCode 2', () => {
    expect(handleSpecVerdict([]).exitCode).toBe(2);
  });
});
