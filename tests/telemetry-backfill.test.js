import { test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sumTranscriptUsage } from '../lib/telemetry-backfill.js';
import { normalizeEntry } from '../bin/advisor-cost';

function writeTranscript(dir, lines) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('sumTranscriptUsage: advisor_message iteration produces two by_model entries (executor + advisor)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-backfill-test-'));
  const msg = {
    message: {
      role: 'assistant', id: 'msg_1', model: 'claude-sonnet-5',
      usage: {
        input_tokens: 20, output_tokens: 8,
        iterations: [
          { type: 'advisor_message', model: 'claude-opus-5', input_tokens: 70648, output_tokens: 6146, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    },
  };
  const p = writeTranscript(tmpDir, [msg]);

  const result = sumTranscriptUsage(p);

  expect(result.counting).toBe('dedupe-v3');
  expect(Object.keys(result.by_model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  expect(result.by_model['claude-opus-5'].input_tokens).toBe(70648);
  expect(result.by_model['claude-opus-5'].output_tokens).toBe(6146);
  expect(result.by_model['claude-sonnet-5'].input_tokens).toBe(20);
  expect(result.breakdown.input_tokens).toBe(20 + 70648);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('sumTranscriptUsage: repeated message.id does not double-count the advisor iteration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-backfill-test-'));
  const msg = {
    message: {
      role: 'assistant', id: 'msg_dup', model: 'claude-sonnet-5',
      usage: {
        input_tokens: 10, output_tokens: 5,
        iterations: [{ type: 'advisor_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 50 }],
      },
    },
  };
  const p = writeTranscript(tmpDir, [msg, msg, msg]);

  const result = sumTranscriptUsage(p);

  expect(result.by_model['claude-opus-5'].input_tokens).toBe(100);
  expect(result.by_model['claude-sonnet-5'].input_tokens).toBe(10);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('sumTranscriptUsage + advisor-cost: real advisor-consulting session prices within 1% of CLI total_cost_usd', () => {
  // Fixture extracted from a real Claude Code session transcript that
  // consulted the advisor tool (~/.claude/projects/*coder-cost-yL3oV7*/
  // 691f52f6-7c50-4a18-a067-dc38dfe7f578.jsonl): only {id, model, usage} kept
  // per assistant message plus the session's own cost-state line — no
  // conversation content copied.
  const fixturePath = path.join(import.meta.dir, 'fixtures', 'advisor-message-real-session-usage.jsonl');
  const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean);
  const costStateLine = lines.map((l) => JSON.parse(l)).find((l) => l.type === 'cost-state');
  const cliTotalCostUsd = costStateLine.totalCostUSD;
  expect(cliTotalCostUsd).toBeCloseTo(1.7164065, 6);

  const result = sumTranscriptUsage(fixturePath);
  expect(result.counting).toBe('dedupe-v3');
  expect(result.by_model['claude-opus-5-5']).toBeDefined(); // the advisor model

  const n = normalizeEntry({ sid: 'fixture', counting: result.counting, total_used: result.total_used, breakdown: result.breakdown, by_model: result.by_model });

  const pctDiff = Math.abs(n.cost - cliTotalCostUsd) / cliTotalCostUsd;
  expect(pctDiff).toBeLessThan(0.01);
});

test('sumTranscriptUsage: no advisor_message iteration stays tagged dedupe-v2', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-backfill-test-'));
  const msg = {
    message: { role: 'assistant', id: 'msg_plain', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
  };
  const p = writeTranscript(tmpDir, [msg]);

  const result = sumTranscriptUsage(p);

  expect(result.counting).toBe('dedupe-v2');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function haikuMsg(id, model, usage) {
  return { message: { role: 'assistant', id, model, usage } };
}

function sumLines(lines) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-backfill-test-'));
  try {
    return sumTranscriptUsage(writeTranscript(tmpDir, lines));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('sumTranscriptUsage: haiku-5-5 below/at/above 100000 prompt in one session splits at the boundary', () => {
  const result = sumLines([
    haikuMsg('h_below', 'claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1, cache_read_input_tokens: 49999 }),
    haikuMsg('h_at', 'claude-haiku-5-5', { input_tokens: 40000, output_tokens: 2, cache_read_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 20000, ephemeral_1h_input_tokens: 10000 } }),
    haikuMsg('h_above', 'claude-haiku-5-5', { input_tokens: 40000, output_tokens: 4, cache_read_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 20000, ephemeral_1h_input_tokens: 10001 } }),
  ]);

  expect(Object.keys(result.by_model).sort()).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5:long']);
  expect(result.by_model['claude-haiku-5-5'].input_tokens).toBe(90000);
  expect(result.by_model['claude-haiku-5-5'].output_tokens).toBe(3);
  expect(result.by_model['claude-haiku-5-5'].cache_creation_1h_input_tokens).toBe(10000);
  expect(result.by_model['claude-haiku-5-5:long']).toEqual({
    input_tokens: 40000, output_tokens: 4, cache_read_input_tokens: 30000,
    cache_creation_5m_input_tokens: 20000, cache_creation_1h_input_tokens: 10001,
  });
  expect(result.breakdown.input_tokens).toBe(130000);
  expect(result.total_used).toBe(50000 + 1 + 49999 + 40000 + 2 + 30000 + 30000 + 40000 + 4 + 30000 + 30001);
});

test('sumTranscriptUsage: dated haiku-5-5 snapshot normalizes; repeated message.id counted once', () => {
  const big = haikuMsg('h_dated', 'claude-haiku-5-5-20260101', { input_tokens: 100001, output_tokens: 3 });
  const result = sumLines([big, big]);

  expect(Object.keys(result.by_model)).toEqual(['claude-haiku-5-5:long']);
  expect(result.by_model['claude-haiku-5-5:long'].input_tokens).toBe(100001);
});

test('sumTranscriptUsage: claude-haiku-4-5 and other models are never split, even with huge prompts', () => {
  const result = sumLines([
    haikuMsg('a', 'claude-haiku-4-5', { input_tokens: 500000, output_tokens: 1 }),
    haikuMsg('b', 'claude-haiku-4-5-20251001', { input_tokens: 500000, output_tokens: 1 }),
    haikuMsg('c', 'claude-sonnet-5', { input_tokens: 500000, output_tokens: 1 }),
    haikuMsg('d', 'claude-opus-5-5', { input_tokens: 500000, output_tokens: 1 }),
  ]);

  expect(Object.keys(result.by_model).sort()).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-5']);
});

test('sumTranscriptUsage: haiku-5-5 advisor_message iteration is split on its own prompt size', () => {
  const result = sumLines([haikuMsg('x', 'claude-sonnet-5', {
    input_tokens: 10, output_tokens: 1,
    iterations: [{ type: 'advisor_message', model: 'claude-haiku-5-5', input_tokens: 100001, output_tokens: 2 }],
  })]);

  expect(result.by_model['claude-haiku-5-5:long'].input_tokens).toBe(100001);
  expect(result.by_model['claude-haiku-5-5']).toBeUndefined();
});
