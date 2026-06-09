// tests/summon-intelligence-map.test.js
// TDD tests for adapter/intelligence-map.json band partition (B1 + N1).
// Pre-fix RED: resolveIntelligence(95/100) return 'claude-opus-4-7' (band 4 shadow), not 'claude-fable-5'.

import { test, expect } from 'bun:test';
import { resolveIntelligence } from '../lib/summon.js';

// Band 1: haiku [0, 39]
test('score 0 resolves to haiku band', () => {
  const r = resolveIntelligence(0);
  expect(r.model).toBe('claude-haiku-4-5-20251001');
  expect(r.reasoning).toBe('low');
});

test('score 39 resolves to haiku band (upper boundary)', () => {
  const r = resolveIntelligence(39);
  expect(r.model).toBe('claude-haiku-4-5-20251001');
});

// Band 2: sonnet-medium [40, 74]
test('score 40 resolves to sonnet medium band (lower boundary)', () => {
  const r = resolveIntelligence(40);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('medium');
});

test('score 74 resolves to sonnet medium band (upper boundary)', () => {
  const r = resolveIntelligence(74);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('medium');
});

// Band 3: sonnet-high [75, 89]
test('score 75 resolves to sonnet high band (lower boundary)', () => {
  const r = resolveIntelligence(75);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('high');
});

test('score 89 resolves to sonnet high band (upper boundary)', () => {
  const r = resolveIntelligence(89);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('high');
});

// Band 4: opus [90, 94]
test('score 90 resolves to opus band (lower boundary)', () => {
  const r = resolveIntelligence(90);
  expect(r.model).toBe('claude-opus-4-7');
  expect(r.reasoning).toBe('high');
});

test('score 94 resolves to opus band (upper boundary)', () => {
  const r = resolveIntelligence(94);
  expect(r.model).toBe('claude-opus-4-7');
});

// Band 5: fable-5 [95, 100] — FAILS pre-fix (band 4 was [90,100] and shadows band 5)
test('score 95 resolves to fable-5 band (lower boundary)', () => {
  const r = resolveIntelligence(95);
  expect(r.model).toBe('claude-fable-5');
  expect(r.reasoning).toBe('higher');
});

test('score 100 resolves to fable-5 band (upper boundary)', () => {
  const r = resolveIntelligence(100);
  expect(r.model).toBe('claude-fable-5');
});

// Model string must not contain literal quote characters
test('fable-5 model string contains no single-quote characters', () => {
  const r = resolveIntelligence(95);
  expect(r.model).not.toContain("'");
});

test('fable-5 model string contains no double-quote characters', () => {
  const r = resolveIntelligence(95);
  expect(r.model).not.toContain('"');
});

// Validator: score > 100 throws RangeError
test('score 101 throws RangeError', () => {
  expect(() => resolveIntelligence(101)).toThrow(RangeError);
});

test('score 101 throws with message mentioning [0,100]', () => {
  expect(() => resolveIntelligence(101)).toThrow(/\[0,100\]/);
});
