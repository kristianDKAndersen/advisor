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
