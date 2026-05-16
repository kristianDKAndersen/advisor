import { test, expect, describe } from 'bun:test';

import { formatBytes } from '../lib/bytes.js';

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe('formatBytes — bytes bucket (n < 1024)', () => {
  test('0 returns "0B"', () => {
    expect(formatBytes(0)).toBe('0B');
  });

  test('1 returns "1B"', () => {
    expect(formatBytes(1)).toBe('1B');
  });

  test('512 returns "512B" (spec example)', () => {
    expect(formatBytes(512)).toBe('512B');
  });

  test('1023 returns "1023B" (upper boundary, exclusive of 1024)', () => {
    expect(formatBytes(1023)).toBe('1023B');
  });
});

describe('formatBytes — KB bucket (1024 <= n < 1024**2)', () => {
  test('1024 returns "1KB" (lower boundary, inclusive)', () => {
    expect(formatBytes(1024)).toBe('1KB');
  });

  test('2048 returns "2KB" (spec example)', () => {
    expect(formatBytes(2048)).toBe('2KB');
  });

  test('1535 returns "1KB" (floors 1.499 KB)', () => {
    expect(formatBytes(1535)).toBe('1KB');
  });

  test('1536 returns "1KB" (1.5 KB floored)', () => {
    expect(formatBytes(1536)).toBe('1KB');
  });

  test('2047 returns "1KB" (just below 2 KB)', () => {
    expect(formatBytes(2047)).toBe('1KB');
  });

  test('5 * 1024 returns "5KB"', () => {
    expect(formatBytes(5 * KB)).toBe('5KB');
  });

  test('1023 * 1024 returns "1023KB"', () => {
    expect(formatBytes(1023 * KB)).toBe('1023KB');
  });

  test('1024**2 - 1 returns "1023KB" (upper boundary, exclusive of MB)', () => {
    expect(formatBytes(MB - 1)).toBe('1023KB');
  });
});

describe('formatBytes — MB bucket (1024**2 <= n < 1024**3)', () => {
  test('1048576 returns "1MB" (spec example, lower boundary inclusive)', () => {
    expect(formatBytes(1048576)).toBe('1MB');
  });

  test('1024**2 returns "1MB" via computed boundary', () => {
    expect(formatBytes(MB)).toBe('1MB');
  });

  test('2 * 1024**2 returns "2MB"', () => {
    expect(formatBytes(2 * MB)).toBe('2MB');
  });

  test('1.5 * 1024**2 floored returns "1MB"', () => {
    expect(formatBytes(Math.floor(1.5 * MB))).toBe('1MB');
  });

  test('2 * 1024**2 - 1 returns "1MB" (just below 2 MB)', () => {
    expect(formatBytes(2 * MB - 1)).toBe('1MB');
  });

  test('100 * 1024**2 returns "100MB"', () => {
    expect(formatBytes(100 * MB)).toBe('100MB');
  });

  test('1023 * 1024**2 returns "1023MB"', () => {
    expect(formatBytes(1023 * MB)).toBe('1023MB');
  });

  test('1024**3 - 1 returns "1023MB" (upper boundary, exclusive of GB)', () => {
    expect(formatBytes(GB - 1)).toBe('1023MB');
  });
});

describe('formatBytes — GB bucket (n >= 1024**3)', () => {
  test('1073741824 returns "1GB" (spec example, lower boundary inclusive)', () => {
    expect(formatBytes(1073741824)).toBe('1GB');
  });

  test('1024**3 returns "1GB" via computed boundary', () => {
    expect(formatBytes(GB)).toBe('1GB');
  });

  test('2 * 1024**3 returns "2GB"', () => {
    expect(formatBytes(2 * GB)).toBe('2GB');
  });

  test('1.5 * 1024**3 floored returns "1GB"', () => {
    expect(formatBytes(Math.floor(1.5 * GB))).toBe('1GB');
  });

  test('5 * 1024**3 returns "5GB"', () => {
    expect(formatBytes(5 * GB)).toBe('5GB');
  });

  test('100 * 1024**3 returns "100GB"', () => {
    expect(formatBytes(100 * GB)).toBe('100GB');
  });

  test('1024**4 returns "1024GB" (beyond GB, no TB bucket per spec)', () => {
    expect(formatBytes(1024 * GB)).toBe('1024GB');
  });
});

describe('formatBytes — boundary integration sweep', () => {
  test('full sweep across all four buckets', () => {
    const cases = [
      [0, '0B'],
      [1, '1B'],
      [512, '512B'],
      [1023, '1023B'],
      [1024, '1KB'],
      [2048, '2KB'],
      [MB - 1, '1023KB'],
      [MB, '1MB'],
      [1048576, '1MB'],
      [2 * MB, '2MB'],
      [GB - 1, '1023MB'],
      [GB, '1GB'],
      [1073741824, '1GB'],
      [2 * GB, '2GB'],
    ];
    for (const [n, expected] of cases) {
      expect(formatBytes(n)).toBe(expected);
    }
  });
});

describe('formatBytes — invalid inputs throw TypeError', () => {
  test('negative -1 throws TypeError with non-negative message', () => {
    expect(() => formatBytes(-1)).toThrow(TypeError);
    expect(() => formatBytes(-1)).toThrow('formatBytes: n must be non-negative');
  });

  test('large negative -1024 throws non-negative message', () => {
    expect(() => formatBytes(-1024)).toThrow('formatBytes: n must be non-negative');
  });

  test('negative fractional -0.5 throws non-negative message', () => {
    expect(() => formatBytes(-0.5)).toThrow('formatBytes: n must be non-negative');
  });

  test('NaN throws TypeError with finite-number message', () => {
    expect(() => formatBytes(NaN)).toThrow(TypeError);
    expect(() => formatBytes(NaN)).toThrow('formatBytes: n must be a finite number');
  });

  test('Infinity throws TypeError with finite-number message', () => {
    expect(() => formatBytes(Infinity)).toThrow(TypeError);
    expect(() => formatBytes(Infinity)).toThrow('formatBytes: n must be a finite number');
  });

  test('-Infinity throws TypeError with finite-number message', () => {
    expect(() => formatBytes(-Infinity)).toThrow(TypeError);
    expect(() => formatBytes(-Infinity)).toThrow('formatBytes: n must be a finite number');
  });

  test('string "100" throws TypeError with finite-number message', () => {
    expect(() => formatBytes('100')).toThrow(TypeError);
    expect(() => formatBytes('100')).toThrow('formatBytes: n must be a finite number');
  });

  test('empty string throws finite-number message', () => {
    expect(() => formatBytes('')).toThrow('formatBytes: n must be a finite number');
  });

  test('null throws TypeError with finite-number message', () => {
    expect(() => formatBytes(null)).toThrow(TypeError);
    expect(() => formatBytes(null)).toThrow('formatBytes: n must be a finite number');
  });

  test('undefined throws TypeError with finite-number message', () => {
    expect(() => formatBytes(undefined)).toThrow(TypeError);
    expect(() => formatBytes(undefined)).toThrow('formatBytes: n must be a finite number');
  });

  test('no-argument call throws finite-number message', () => {
    expect(() => formatBytes()).toThrow(TypeError);
    expect(() => formatBytes()).toThrow('formatBytes: n must be a finite number');
  });

  test('boolean true throws finite-number message', () => {
    expect(() => formatBytes(true)).toThrow(TypeError);
    expect(() => formatBytes(true)).toThrow('formatBytes: n must be a finite number');
  });

  test('boolean false throws finite-number message', () => {
    expect(() => formatBytes(false)).toThrow(TypeError);
    expect(() => formatBytes(false)).toThrow('formatBytes: n must be a finite number');
  });

  test('plain object throws finite-number message', () => {
    expect(() => formatBytes({})).toThrow(TypeError);
    expect(() => formatBytes({})).toThrow('formatBytes: n must be a finite number');
  });

  test('array throws finite-number message', () => {
    expect(() => formatBytes([1])).toThrow(TypeError);
    expect(() => formatBytes([1])).toThrow('formatBytes: n must be a finite number');
  });

  test('thrown error is a TypeError instance (not generic Error) for negative', () => {
    try {
      formatBytes(-1);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
  });

  test('thrown error is a TypeError instance (not generic Error) for non-number', () => {
    try {
      formatBytes('x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
  });
});

describe('formatBytes — return type and shape', () => {
  test('returns a string for each bucket', () => {
    expect(typeof formatBytes(0)).toBe('string');
    expect(typeof formatBytes(512)).toBe('string');
    expect(typeof formatBytes(2048)).toBe('string');
    expect(typeof formatBytes(MB)).toBe('string');
    expect(typeof formatBytes(GB)).toBe('string');
  });

  test('bytes output matches /^\\d+B$/', () => {
    expect(formatBytes(0)).toMatch(/^\d+B$/);
    expect(formatBytes(512)).toMatch(/^\d+B$/);
    expect(formatBytes(1023)).toMatch(/^\d+B$/);
  });

  test('KB output matches /^\\d+KB$/', () => {
    expect(formatBytes(1024)).toMatch(/^\d+KB$/);
    expect(formatBytes(2048)).toMatch(/^\d+KB$/);
    expect(formatBytes(MB - 1)).toMatch(/^\d+KB$/);
  });

  test('MB output matches /^\\d+MB$/', () => {
    expect(formatBytes(MB)).toMatch(/^\d+MB$/);
    expect(formatBytes(100 * MB)).toMatch(/^\d+MB$/);
    expect(formatBytes(GB - 1)).toMatch(/^\d+MB$/);
  });

  test('GB output matches /^\\d+GB$/', () => {
    expect(formatBytes(GB)).toMatch(/^\d+GB$/);
    expect(formatBytes(2 * GB)).toMatch(/^\d+GB$/);
    expect(formatBytes(1024 * GB)).toMatch(/^\d+GB$/);
  });

  test('no spaces in any output', () => {
    expect(formatBytes(0)).not.toMatch(/\s/);
    expect(formatBytes(1024)).not.toMatch(/\s/);
    expect(formatBytes(MB)).not.toMatch(/\s/);
    expect(formatBytes(GB)).not.toMatch(/\s/);
  });

  test('module exports formatBytes as a named export (dynamic import)', async () => {
    const mod = await import('../lib/bytes.js');
    expect(typeof mod.formatBytes).toBe('function');
  });
});
