import { test, expect } from 'bun:test';
// aggregateSynthesis is not yet exported from lib/parallel.js — this is the RED signal.
// When the function is added and exported, these tests will turn GREEN.
import { aggregateSynthesis } from '../lib/parallel.js';

test('aggregateSynthesis is exported from lib/parallel.js', () => {
  expect(typeof aggregateSynthesis).toBe('function');
});

test('aggregateSynthesis returns report with synthesis field and correct shape', () => {
  const workers = [
    { verdict: 'complete', summary: 'worker 1 done', status: 'result' },
    { verdict: 'partial', summary: 'worker 2 partial', status: 'result' },
    { verdict: 'blocked', summary: 'worker 3 blocked', status: 'result' },
  ];
  const report = aggregateSynthesis(workers);
  expect(typeof report.synthesis.summary).toBe('string');
  expect(typeof report.synthesis.worker_count).toBe('number');
  expect(typeof report.synthesis.verdict_counts).toBe('object');
  expect(typeof report.synthesis.verdict_counts.complete).toBe('number');
  expect(typeof report.synthesis.verdict_counts.partial).toBe('number');
  expect(typeof report.synthesis.verdict_counts.blocked).toBe('number');
});
