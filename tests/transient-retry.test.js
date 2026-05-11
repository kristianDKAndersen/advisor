import { test, expect } from 'bun:test';

import { classifyError, backoffMs } from '../lib/transient-retry.js';

// --- classifyError: transient cases ---

test('classifyError: 503 service unavailable → transient', () => {
  expect(classifyError({ stderr: 'Status 503 service unavailable', exitCode: 1 })).toBe('transient');
});

test('classifyError: rate_limit_error → transient', () => {
  expect(classifyError({ stderr: 'rate_limit_error: too many requests', exitCode: 1 })).toBe('transient');
});

test('classifyError: overloaded_error → transient', () => {
  expect(classifyError({ stderr: 'overloaded_error', exitCode: 1 })).toBe('transient');
});

test('classifyError: ECONNRESET → transient', () => {
  expect(classifyError({ stderr: 'ECONNRESET', exitCode: 1 })).toBe('transient');
});

// --- classifyError: fatal cases ---

test('classifyError: 401 Unauthorized → fatal', () => {
  expect(classifyError({ stderr: '401 Unauthorized', exitCode: 1 })).toBe('fatal');
});

test('classifyError: invalid api key → fatal', () => {
  expect(classifyError({ stderr: 'invalid api key', exitCode: 1 })).toBe('fatal');
});

test('classifyError: context_length_exceeded → fatal', () => {
  expect(classifyError({ stderr: 'context_length_exceeded', exitCode: 1 })).toBe('fatal');
});

test('classifyError: subscription required → fatal', () => {
  expect(classifyError({ stderr: 'subscription required', exitCode: 1 })).toBe('fatal');
});

// --- classifyError: unknown cases ---

test('classifyError: random garbage → unknown', () => {
  expect(classifyError({ stderr: 'some random garbage', exitCode: 1 })).toBe('unknown');
});

test('classifyError: empty stderr + exitCode 0 → unknown', () => {
  expect(classifyError({ stderr: '', exitCode: 0 })).toBe('unknown');
});

// --- CRITICAL ORDER TEST: fatal patterns evaluated FIRST ---

test('classifyError: 503 + 401 mixed → fatal (fatal-first rule)', () => {
  expect(
    classifyError({ stderr: 'Status 503 overloaded but also 401 authentication failed', exitCode: 1 })
  ).toBe('fatal');
});

// --- backoffMs ---

test('backoffMs(0) === 5000', () => {
  expect(backoffMs(0)).toBe(5000);
});

test('backoffMs(1) === 15000', () => {
  expect(backoffMs(1)).toBe(15000);
});

test('backoffMs(2) === 45000', () => {
  expect(backoffMs(2)).toBe(45000);
});

test('backoffMs(5) === 45000 (capped at attempt=2)', () => {
  expect(backoffMs(5)).toBe(45000);
});
