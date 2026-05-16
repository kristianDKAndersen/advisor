import { test, expect, describe } from 'bun:test';

import { formatDuration } from '../lib/duration.js';

describe('formatDuration — sub-second bucket (ms < 1000)', () => {
  test('0 returns "0ms"', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  test('1 returns "1ms"', () => {
    expect(formatDuration(1)).toBe('1ms');
  });

  test('250 returns "250ms" (spec example)', () => {
    expect(formatDuration(250)).toBe('250ms');
  });

  test('500 returns "500ms"', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  test('999 returns "999ms" (upper boundary, exclusive)', () => {
    expect(formatDuration(999)).toBe('999ms');
  });
});

describe('formatDuration — seconds bucket (1000 <= ms < 60_000)', () => {
  test('1000 returns "1s" (lower boundary, inclusive)', () => {
    expect(formatDuration(1000)).toBe('1s');
  });

  test('1500 returns "1s" (spec example, floors fractional seconds)', () => {
    expect(formatDuration(1500)).toBe('1s');
  });

  test('1999 returns "1s" (just below 2s, floored)', () => {
    expect(formatDuration(1999)).toBe('1s');
  });

  test('2000 returns "2s"', () => {
    expect(formatDuration(2000)).toBe('2s');
  });

  test('30_000 returns "30s"', () => {
    expect(formatDuration(30_000)).toBe('30s');
  });

  test('59_000 returns "59s"', () => {
    expect(formatDuration(59_000)).toBe('59s');
  });

  test('59_999 returns "59s" (upper boundary, exclusive)', () => {
    expect(formatDuration(59_999)).toBe('59s');
  });
});

describe('formatDuration — minutes bucket (60_000 <= ms < 3_600_000)', () => {
  test('60_000 returns "1m 0s" (lower boundary, inclusive)', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
  });

  test('61_000 returns "1m 1s"', () => {
    expect(formatDuration(61_000)).toBe('1m 1s');
  });

  test('75_000 returns "1m 15s" (spec example)', () => {
    expect(formatDuration(75_000)).toBe('1m 15s');
  });

  test('119_999 returns "1m 59s"', () => {
    expect(formatDuration(119_999)).toBe('1m 59s');
  });

  test('120_000 returns "2m 0s"', () => {
    expect(formatDuration(120_000)).toBe('2m 0s');
  });

  test('600_000 returns "10m 0s"', () => {
    expect(formatDuration(600_000)).toBe('10m 0s');
  });

  test('3_599_000 returns "59m 59s"', () => {
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  test('3_599_999 returns "59m 59s" (just below 1h boundary)', () => {
    expect(formatDuration(3_599_999)).toBe('59m 59s');
  });
});

describe('formatDuration — hours bucket (ms >= 3_600_000)', () => {
  test('3_600_000 returns "1h 0m" (lower boundary, inclusive)', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
  });

  test('3_660_000 returns "1h 1m"', () => {
    expect(formatDuration(3_660_000)).toBe('1h 1m');
  });

  test('3_725_000 returns "1h 2m" (spec example, seconds dropped)', () => {
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });

  test('seconds component dropped at hour boundary', () => {
    const out = formatDuration(3_725_000);
    expect(out).not.toMatch(/\d+s/);
    expect(out).toBe('1h 2m');
  });

  test('7_200_000 returns "2h 0m"', () => {
    expect(formatDuration(7_200_000)).toBe('2h 0m');
  });

  test('86_400_000 (24h) returns "24h 0m"', () => {
    expect(formatDuration(86_400_000)).toBe('24h 0m');
  });

  test('100h 30m: 100 * 3_600_000 + 30 * 60_000 returns "100h 30m"', () => {
    const ms = 100 * 3_600_000 + 30 * 60_000;
    expect(formatDuration(ms)).toBe('100h 30m');
  });
});

describe('formatDuration — fractional ms are floored before formatting', () => {
  test('0.5 returns "0ms"', () => {
    expect(formatDuration(0.5)).toBe('0ms');
  });

  test('999.9 returns "999ms" (spec example, stays sub-second)', () => {
    expect(formatDuration(999.9)).toBe('999ms');
  });

  test('1000.7 returns "1s"', () => {
    expect(formatDuration(1000.7)).toBe('1s');
  });

  test('1999.9 returns "1s"', () => {
    expect(formatDuration(1999.9)).toBe('1s');
  });

  test('59_999.9 returns "59s" (still under the minute boundary after floor)', () => {
    expect(formatDuration(59_999.9)).toBe('59s');
  });

  test('3_599_999.9 returns "59m 59s" (floor keeps just below 1h)', () => {
    expect(formatDuration(3_599_999.9)).toBe('59m 59s');
  });
});

describe('formatDuration — invalid inputs throw TypeError', () => {
  test('negative -1 throws TypeError with non-negative message', () => {
    expect(() => formatDuration(-1)).toThrow(TypeError);
    expect(() => formatDuration(-1)).toThrow('formatDuration: ms must be non-negative');
  });

  test('large negative -1000 throws non-negative message', () => {
    expect(() => formatDuration(-1000)).toThrow('formatDuration: ms must be non-negative');
  });

  test('negative fractional -0.5 throws non-negative message', () => {
    expect(() => formatDuration(-0.5)).toThrow('formatDuration: ms must be non-negative');
  });

  test('string "100" throws TypeError with finite-number message', () => {
    expect(() => formatDuration('100')).toThrow(TypeError);
    expect(() => formatDuration('100')).toThrow('formatDuration: ms must be a finite number');
  });

  test('empty string throws finite-number message', () => {
    expect(() => formatDuration('')).toThrow('formatDuration: ms must be a finite number');
  });

  test('null throws TypeError with finite-number message', () => {
    expect(() => formatDuration(null)).toThrow(TypeError);
    expect(() => formatDuration(null)).toThrow('formatDuration: ms must be a finite number');
  });

  test('undefined throws TypeError with finite-number message', () => {
    expect(() => formatDuration(undefined)).toThrow(TypeError);
    expect(() => formatDuration(undefined)).toThrow('formatDuration: ms must be a finite number');
  });

  test('no-argument call throws finite-number message', () => {
    expect(() => formatDuration()).toThrow(TypeError);
    expect(() => formatDuration()).toThrow('formatDuration: ms must be a finite number');
  });

  test('NaN throws TypeError with finite-number message', () => {
    expect(() => formatDuration(NaN)).toThrow(TypeError);
    expect(() => formatDuration(NaN)).toThrow('formatDuration: ms must be a finite number');
  });

  test('Infinity throws TypeError with finite-number message', () => {
    expect(() => formatDuration(Infinity)).toThrow(TypeError);
    expect(() => formatDuration(Infinity)).toThrow('formatDuration: ms must be a finite number');
  });

  test('-Infinity throws TypeError with finite-number message', () => {
    expect(() => formatDuration(-Infinity)).toThrow(TypeError);
    expect(() => formatDuration(-Infinity)).toThrow('formatDuration: ms must be a finite number');
  });

  test('boolean true throws finite-number message', () => {
    expect(() => formatDuration(true)).toThrow(TypeError);
    expect(() => formatDuration(true)).toThrow('formatDuration: ms must be a finite number');
  });

  test('boolean false throws finite-number message', () => {
    expect(() => formatDuration(false)).toThrow(TypeError);
    expect(() => formatDuration(false)).toThrow('formatDuration: ms must be a finite number');
  });

  test('plain object throws finite-number message', () => {
    expect(() => formatDuration({})).toThrow(TypeError);
    expect(() => formatDuration({})).toThrow('formatDuration: ms must be a finite number');
  });

  test('array throws finite-number message', () => {
    expect(() => formatDuration([1])).toThrow(TypeError);
    expect(() => formatDuration([1])).toThrow('formatDuration: ms must be a finite number');
  });

  test('thrown error is a TypeError instance (not generic Error)', () => {
    try {
      formatDuration(-1);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
    try {
      formatDuration('x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
  });
});

describe('formatDuration — return type and shape', () => {
  test('returns a string for each bucket', () => {
    expect(typeof formatDuration(0)).toBe('string');
    expect(typeof formatDuration(500)).toBe('string');
    expect(typeof formatDuration(5_000)).toBe('string');
    expect(typeof formatDuration(120_000)).toBe('string');
    expect(typeof formatDuration(3_700_000)).toBe('string');
  });

  test('sub-second output matches /^\\d+ms$/', () => {
    expect(formatDuration(0)).toMatch(/^\d+ms$/);
    expect(formatDuration(500)).toMatch(/^\d+ms$/);
    expect(formatDuration(999)).toMatch(/^\d+ms$/);
  });

  test('seconds output matches /^\\d+s$/ (no m, no h)', () => {
    expect(formatDuration(1000)).toMatch(/^\d+s$/);
    expect(formatDuration(45_000)).toMatch(/^\d+s$/);
    expect(formatDuration(59_999)).toMatch(/^\d+s$/);
  });

  test('minutes output matches /^\\d+m \\d+s$/', () => {
    expect(formatDuration(60_000)).toMatch(/^\d+m \d+s$/);
    expect(formatDuration(75_000)).toMatch(/^\d+m \d+s$/);
    expect(formatDuration(3_599_000)).toMatch(/^\d+m \d+s$/);
  });

  test('hours output matches /^\\d+h \\d+m$/ (no seconds component)', () => {
    expect(formatDuration(3_600_000)).toMatch(/^\d+h \d+m$/);
    expect(formatDuration(3_725_000)).toMatch(/^\d+h \d+m$/);
    expect(formatDuration(86_400_000)).toMatch(/^\d+h \d+m$/);
  });
});

describe('formatDuration — boundary integration sweep', () => {
  test('full sweep across all four buckets', () => {
    const cases = [
      [0, '0ms'],
      [1, '1ms'],
      [999, '999ms'],
      [1000, '1s'],
      [1500, '1s'],
      [59_999, '59s'],
      [60_000, '1m 0s'],
      [75_000, '1m 15s'],
      [3_599_999, '59m 59s'],
      [3_600_000, '1h 0m'],
      [3_725_000, '1h 2m'],
    ];
    for (const [ms, expected] of cases) {
      expect(formatDuration(ms)).toBe(expected);
    }
  });

  test('module exports formatDuration as a named export (dynamic import)', async () => {
    const mod = await import('../lib/duration.js');
    expect(typeof mod.formatDuration).toBe('function');
  });
});
