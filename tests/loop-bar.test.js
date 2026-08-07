// tests/loop-bar.test.js
// RED: fails until lib/loop-bar.js exists.

import { test, expect } from 'bun:test';
import { resolveBar, NoBarError } from '../lib/loop-bar.js';

test('resolves external-reference bar from explicit flags', () => {
  const bar = resolveBar({ barType: 'external-reference', barRef: '/path/to/reference.png' });
  expect(bar).toEqual({ type: 'external-reference', ref: '/path/to/reference.png' });
});

test('resolves acceptance-tests bar from explicit flags', () => {
  const bar = resolveBar({ barType: 'acceptance-tests', barRef: 'bun test tests/foo.test.js' });
  expect(bar).toEqual({ type: 'acceptance-tests', ref: 'bun test tests/foo.test.js' });
});

test('resolves prior-round bar from explicit flags', () => {
  const bar = resolveBar({ barType: 'prior-round', barRef: { worktree_path: '/tmp/round0' } });
  expect(bar).toEqual({ type: 'prior-round', ref: { worktree_path: '/tmp/round0' } });
});

test('resolves metric bar from explicit flags', () => {
  const bar = resolveBar({
    barType: 'metric',
    barRef: { name: 'p95_latency_ms', op: '<=', value: 200 },
  });
  expect(bar).toEqual({
    type: 'metric',
    ref: { name: 'p95_latency_ms', op: '<=', value: 200 },
  });
});

test('resolves acceptance-tests bar from a spec test_command when no explicit flags given', () => {
  const bar = resolveBar({ spec: { test_command: 'bun test tests/auth.test.js' } });
  expect(bar).toEqual({ type: 'acceptance-tests', ref: 'bun test tests/auth.test.js' });
});

test('resolves prior-round bar from --refine when no explicit flags or spec given', () => {
  const bar = resolveBar({ refine: true, priorRoundArtifacts: { worktree_path: '/tmp/round0' } });
  expect(bar).toEqual({ type: 'prior-round', ref: { worktree_path: '/tmp/round0' } });
});

test('precedence: explicit bar-type/bar-ref wins over a spec test_command', () => {
  const bar = resolveBar({
    barType: 'metric',
    barRef: { name: 'x', op: '<=', value: 1 },
    spec: { test_command: 'bun test tests/foo.test.js' },
  });
  expect(bar.type).toBe('metric');
});

test('precedence: spec test_command wins over --refine', () => {
  const bar = resolveBar({
    spec: { test_command: 'bun test tests/foo.test.js' },
    refine: true,
    priorRoundArtifacts: { worktree_path: '/tmp/round0' },
  });
  expect(bar.type).toBe('acceptance-tests');
});

test('throws a distinct NoBarError when no bar is resolvable', () => {
  expect(() => resolveBar({})).toThrow(NoBarError);
});

test('NoBarError is not a generic Error subtype masquerading as one, and maps to exit code 6', () => {
  try {
    resolveBar({});
    throw new Error('expected resolveBar to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(NoBarError);
    expect(err.name).toBe('NoBarError');
    expect(err.exitCode).toBe(6);
  }
});

test('--refine without prior round artifacts throws NoBarError, never a silent rubric fallback', () => {
  expect(() => resolveBar({ refine: true })).toThrow(NoBarError);
});

test('no code path returns a rubric-style bar when inputs are empty', () => {
  const emptyInputs = [{}, { barType: undefined, barRef: undefined }, { spec: {} }, { spec: null }];
  for (const input of emptyInputs) {
    expect(() => resolveBar(input)).toThrow(NoBarError);
  }
});
