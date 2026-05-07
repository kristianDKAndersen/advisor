import { test, expect } from 'bun:test';

// U3: lib/compactor.js does not exist yet.
// All tests in this file will fail on import with module-not-found — that IS the red signal.

import {
  compactMessages,
  repairToolUseResultPairing,
  summarizeInStages,
} from '../lib/compactor.js';

test('compactMessages is a function (4-phase pipeline)', () => {
  expect(typeof compactMessages).toBe('function');
});

test('repairToolUseResultPairing is a function', () => {
  expect(typeof repairToolUseResultPairing).toBe('function');
});

test('summarizeInStages is a function', () => {
  expect(typeof summarizeInStages).toBe('function');
});

test('compactMessages runs 4-phase pipeline: prune, boundary, summarize, sanitize', async () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ];
  const result = await compactMessages(messages, { maxTokens: 1000 });
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});

test('repairToolUseResultPairing re-pairs orphaned tool_use and tool_result blocks', () => {
  const orphaned = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'abc', name: 'Bash', input: {} }] },
    // tool_result missing — orphaned
  ];
  const repaired = repairToolUseResultPairing(orphaned);
  // Every tool_use must have a matching tool_result
  const uses = repaired.flatMap(m =>
    Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use') : []
  );
  const results = repaired.flatMap(m =>
    Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []
  );
  expect(results.length).toBe(uses.length);
});

test('summarizeInStages preserves stage boundaries', async () => {
  const stages = [
    [{ role: 'user', content: 'stage 1' }],
    [{ role: 'user', content: 'stage 2' }],
  ];
  const summaries = await summarizeInStages(stages);
  expect(summaries.length).toBe(stages.length);
});
