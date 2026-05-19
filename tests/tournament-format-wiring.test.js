import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Verify lib/duration.js and lib/bytes.js are require()-able from CommonJS (Phase B change, commit 23755fd).
// bun exposes require() as a global in both CJS and ESM contexts.

describe('lib/duration.js CommonJS require() wiring', () => {
  test('require() succeeds and formatDuration is a function', () => {
    const mod = require('../lib/duration.js');
    expect(typeof mod.formatDuration).toBe('function');
  });

  test('formatDuration(63000) === "1m 3s"', () => {
    const { formatDuration } = require('../lib/duration.js');
    expect(formatDuration(63000)).toBe('1m 3s');
  });

  test('formatDuration(1000) === "1s"', () => {
    const { formatDuration } = require('../lib/duration.js');
    expect(formatDuration(1000)).toBe('1s');
  });

  test('formatDuration(500) === "500ms"', () => {
    const { formatDuration } = require('../lib/duration.js');
    expect(formatDuration(500)).toBe('500ms');
  });
});

describe('lib/bytes.js CommonJS require() wiring', () => {
  test('require() succeeds and formatBytes is a function', () => {
    const mod = require('../lib/bytes.js');
    expect(typeof mod.formatBytes).toBe('function');
  });

  test('formatBytes(1024) === "1KB"', () => {
    const { formatBytes } = require('../lib/bytes.js');
    expect(formatBytes(1024)).toBe('1KB');
  });

  test('formatBytes(0) === "0B"', () => {
    const { formatBytes } = require('../lib/bytes.js');
    expect(formatBytes(0)).toBe('0B');
  });

  test('formatBytes(1048576) === "1MB"', () => {
    const { formatBytes } = require('../lib/bytes.js');
    expect(formatBytes(1048576)).toBe('1MB');
  });
});

describe('bin/tournament parse-time safety', () => {
  test('bin/tournament source is syntactically valid JS (new Function wrap)', () => {
    const raw = readFileSync(resolve(import.meta.dir, '../bin/tournament'), 'utf8');
    // Strip shebang before syntax check — new Function() rejects '#' as invalid.
    const src = raw.startsWith('#!') ? raw.slice(raw.indexOf('\n') + 1) : raw;
    expect(() => new Function(src)).not.toThrow();
  });
});
