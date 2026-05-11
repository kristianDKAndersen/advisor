import { test, expect, beforeEach, afterEach } from 'bun:test';
import { preflight } from '../lib/preflight.js';

// Tests (a)-(c) need ANTHROPIC_API_KEY set so the key guard passes (stub is used, no real network).
// Test (d) explicitly removes it and asserts fail-open without calling the stub.

let savedKey;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  if (savedKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = savedKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// (a) stub returns vague result — assert result equals exactly that shape
test('preflight returns stub result when anthropicClient resolves', async () => {
  const stubResult = { is_vague: true, gap_signals: ['audience'] };
  const deps = {
    anthropicClient: {
      messages: {
        create: async () => ({ content: [{ text: JSON.stringify(stubResult) }] }),
      },
    },
  };
  const result = await preflight({ prompt: 'do something', deps });
  expect(result).toEqual(stubResult);
});

// (b) stub throws — assert fail-open
test('preflight returns fail-open when anthropicClient throws', async () => {
  const deps = {
    anthropicClient: {
      messages: {
        create: async () => { throw new Error('network error'); },
      },
    },
  };
  const result = await preflight({ prompt: 'do something', deps });
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
});

// (c) stub hangs forever — timeout 50ms — resolves fail-open within 200ms
test('preflight resolves fail-open within 200ms when stub hangs and timeoutMs:50', async () => {
  const deps = {
    anthropicClient: {
      messages: {
        create: () => new Promise(() => {}), // never resolves
      },
    },
  };
  const start = Date.now();
  const result = await preflight({ prompt: 'do something', timeoutMs: 50, deps });
  const elapsed = Date.now() - start;
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
  expect(elapsed).toBeLessThan(200);
});

// (d) no API key in env — fail-open without calling the stub
test('preflight returns fail-open without calling stub when ANTHROPIC_API_KEY is missing', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let called = false;
  const deps = {
    anthropicClient: {
      messages: {
        create: async () => {
          called = true;
          throw new Error('should not be called');
        },
      },
    },
  };
  const result = await preflight({ prompt: 'do something', deps });
  expect(result).toEqual({ is_vague: false, gap_signals: [] });
  expect(called).toBe(false);
});
