// tests/summon-intelligence-map.test.js
// Tests for adapter/intelligence-map.json band partition — intentional 7-band layout:
// [0,29] haiku/low, [30,49] haiku/high, [50,69] sonnet-4-6/medium, [70,84] sonnet-4-6/high,
// [85,89] opus-4-8/medium, [90,94] opus-4-8/high, [95,100] fable-5/high.

import { test, expect } from 'bun:test';
import { resolveIntelligence } from '../lib/summon.js';

// Band 1: haiku low [0, 29]
test('score 0 resolves to haiku low band', () => {
  const r = resolveIntelligence(0);
  expect(r.model).toBe('claude-haiku-4-5-20251001');
  expect(r.reasoning).toBe('low');
});

test('score 29 resolves to haiku low band (upper boundary)', () => {
  const r = resolveIntelligence(29);
  expect(r.model).toBe('claude-haiku-4-5-20251001');
  expect(r.reasoning).toBe('low');
});

// Band 2: haiku high [30, 49]
test('score 30 resolves to haiku high band (lower boundary)', () => {
  const r = resolveIntelligence(30);
  expect(r.model).toBe('claude-haiku-4-5-20251001');
  expect(r.reasoning).toBe('high');
});

test('score 49 resolves to haiku high band (upper boundary)', () => {
  const r = resolveIntelligence(49);
  expect(r.model).toBe('claude-haiku-4-5-20251001');
  expect(r.reasoning).toBe('high');
});

// Band 3: sonnet medium [50, 69]
test('score 50 resolves to sonnet medium band (lower boundary)', () => {
  const r = resolveIntelligence(50);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('medium');
});

test('score 69 resolves to sonnet medium band (upper boundary)', () => {
  const r = resolveIntelligence(69);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('medium');
});

// Band 4: sonnet high [70, 84]
test('score 70 resolves to sonnet high band (lower boundary)', () => {
  const r = resolveIntelligence(70);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('high');
});

test('score 84 resolves to sonnet high band (upper boundary)', () => {
  const r = resolveIntelligence(84);
  expect(r.model).toBe('claude-sonnet-4-6');
  expect(r.reasoning).toBe('high');
});

// Band 5: opus medium [85, 89]
test('score 85 resolves to opus medium band (lower boundary)', () => {
  const r = resolveIntelligence(85);
  expect(r.model).toBe('claude-opus-4-8');
  expect(r.reasoning).toBe('medium');
});

test('score 89 resolves to opus medium band (upper boundary)', () => {
  const r = resolveIntelligence(89);
  expect(r.model).toBe('claude-opus-4-8');
  expect(r.reasoning).toBe('medium');
});

// Band 6: opus high [90, 94]
test('score 90 resolves to opus high band (lower boundary)', () => {
  const r = resolveIntelligence(90);
  expect(r.model).toBe('claude-opus-4-8');
  expect(r.reasoning).toBe('high');
});

test('score 94 resolves to opus high band (upper boundary)', () => {
  const r = resolveIntelligence(94);
  expect(r.model).toBe('claude-opus-4-8');
  expect(r.reasoning).toBe('high');
});

// Band 7: fable-5 [95, 100]
test('score 95 resolves to fable-5 band (lower boundary)', () => {
  const r = resolveIntelligence(95);
  expect(r.model).toBe('claude-fable-5');
  expect(r.reasoning).toBe('high');
});

test('score 100 resolves to fable-5 band (upper boundary)', () => {
  const r = resolveIntelligence(100);
  expect(r.model).toBe('claude-fable-5');
  expect(r.reasoning).toBe('high');
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
