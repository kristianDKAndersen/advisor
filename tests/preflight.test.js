import { test, expect } from 'bun:test';
import { preflight } from '../lib/preflight.js';

// (a) runner returns valid JSON text — assert parsed result
test('preflight parses claudeRunner output into result', async () => {
  const stubResult = { is_vague: true, gap_signals: ['audience'] };
  const deps = {
    claudeRunner: async () => JSON.stringify(stubResult),
  };
  const result = await preflight({ prompt: 'do something', deps });
  expect(result).toEqual(stubResult);
});

// (b) runner throws — fail-open
test('preflight returns fail-open when claudeRunner throws', async () => {
  const deps = {
    claudeRunner: async () => { throw new Error('claude failed'); },
  };
  const result = await preflight({ prompt: 'do something', deps });
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
});

// (c) runner hangs — timeout enforced — fail-open within 200ms
test('preflight resolves fail-open within 200ms when runner hangs and timeoutMs:50', async () => {
  const deps = {
    claudeRunner: ({ timeoutMs }) =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  };
  const start = Date.now();
  const result = await preflight({ prompt: 'do something', timeoutMs: 50, deps });
  const elapsed = Date.now() - start;
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
  expect(elapsed).toBeLessThan(200);
});

// (d) empty/missing prompt — fail-open without invoking runner
test('preflight returns fail-open without calling runner when prompt is empty', async () => {
  let called = false;
  const deps = {
    claudeRunner: async () => { called = true; return '{}'; },
  };
  const result = await preflight({ prompt: '', deps });
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
  expect(called).toBe(false);
});

// (e) runner returns markdown-wrapped JSON — extract and parse
test('preflight strips ```json fences before parsing', async () => {
  const deps = {
    claudeRunner: async () => '```json\n{"is_vague": false, "gap_signals": []}\n```',
  };
  const result = await preflight({ prompt: 'clear task', deps });
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
});

// (f) runner returns malformed JSON — fail-open
test('preflight returns fail-open when output is unparseable', async () => {
  const deps = {
    claudeRunner: async () => 'not json at all',
  };
  const result = await preflight({ prompt: 'something', deps });
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
});
