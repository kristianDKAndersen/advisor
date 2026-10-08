// tests/summon-intelligence-map.test.js
// Tests for adapter/intelligence-map.json band partition — intentional 7-band layout:
// [0,29] haiku/low, [30,49] haiku/high, [50,69] sonnet-5-5/medium, [70,84] sonnet-5-5/high,
// [85,89] opus-5-5/medium, [90,94] opus-5-5/high, [95,100] opus-5-5/max.

import { test, expect } from 'bun:test';
import { resolveIntelligence } from '../lib/summon.js';

// Band 1: haiku low [0, 29]
test('score 0 resolves to haiku low band', () => {
  const r = resolveIntelligence(0);
  expect(r.model).toBe('claude-haiku-5-5');
  expect(r.reasoning).toBe('low');
});

test('score 29 resolves to haiku low band (upper boundary)', () => {
  const r = resolveIntelligence(29);
  expect(r.model).toBe('claude-haiku-5-5');
  expect(r.reasoning).toBe('low');
});

// Band 2: haiku high [30, 49]
test('score 30 resolves to haiku high band (lower boundary)', () => {
  const r = resolveIntelligence(30);
  expect(r.model).toBe('claude-haiku-5-5');
  expect(r.reasoning).toBe('high');
});

test('score 49 resolves to haiku high band (upper boundary)', () => {
  const r = resolveIntelligence(49);
  expect(r.model).toBe('claude-haiku-5-5');
  expect(r.reasoning).toBe('high');
});

// Band 3: sonnet medium [50, 69]
test('score 50 resolves to sonnet medium band (lower boundary)', () => {
  const r = resolveIntelligence(50);
  expect(r.model).toBe('claude-sonnet-5-5');
  expect(r.reasoning).toBe('medium');
});

test('score 69 resolves to sonnet medium band (upper boundary)', () => {
  const r = resolveIntelligence(69);
  expect(r.model).toBe('claude-sonnet-5-5');
  expect(r.reasoning).toBe('medium');
});

// Band 4: sonnet high [70, 84]
test('score 70 resolves to sonnet high band (lower boundary)', () => {
  const r = resolveIntelligence(70);
  expect(r.model).toBe('claude-sonnet-5-5');
  expect(r.reasoning).toBe('high');
});

test('score 84 resolves to sonnet high band (upper boundary)', () => {
  const r = resolveIntelligence(84);
  expect(r.model).toBe('claude-sonnet-5-5');
  expect(r.reasoning).toBe('high');
});

// Band 5: opus medium [85, 89]
test('score 85 resolves to opus medium band (lower boundary)', () => {
  const r = resolveIntelligence(85);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('medium');
});

test('score 89 resolves to opus medium band (upper boundary)', () => {
  const r = resolveIntelligence(89);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('medium');
});

// Band 6: opus high [90, 94]
test('score 90 resolves to opus high band (lower boundary)', () => {
  const r = resolveIntelligence(90);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('high');
});

test('score 94 resolves to opus high band (upper boundary)', () => {
  const r = resolveIntelligence(94);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('high');
});

// Band 7: opus-5-5 max [95, 100]
test('score 95 resolves to opus-5-5 max band (lower boundary)', () => {
  const r = resolveIntelligence(95);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('max');
});

test('score 100 resolves to opus-5-5 max band (upper boundary)', () => {
  const r = resolveIntelligence(100);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('max');
});

// Model string must not contain literal quote characters
test('top-band (opus-5-5) model string contains no single-quote characters', () => {
  const r = resolveIntelligence(95);
  expect(r.model).not.toContain("'");
});

test('top-band (opus-5-5) model string contains no double-quote characters', () => {
  const r = resolveIntelligence(95);
  expect(r.model).not.toContain('"');
});

// Validator: finite out-of-range scores clamp to the nearest bound instead of throwing
test('score 101 clamps to the 100 band instead of throwing', () => {
  const r = resolveIntelligence(101);
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.reasoning).toBe('max');
});

test('score -1 clamps to the 0 band instead of throwing', () => {
  const r0 = resolveIntelligence(0);
  const r = resolveIntelligence(-1);
  expect(r.model).toBe(r0.model);
  expect(r.reasoning).toBe(r0.reasoning);
});

test('non-numeric score still throws RangeError mentioning [0,100]', () => {
  expect(() => resolveIntelligence('abc')).toThrow(/\[0,100\]/);
});

// Validator: no band should reference a haiku-4 model
test('no band references a haiku-4 model', () => {
  for (let score = 0; score <= 100; score++) {
    const r = resolveIntelligence(score);
    expect(r.model).not.toMatch(/haiku-4/);
  }
});
