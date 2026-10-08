import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const STOP_TELEMETRY = path.resolve(import.meta.dir, '../.claude/hooks/stop-telemetry.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-telemetry-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeInput(transcriptPath, sessionId = 'test-sid-001') {
  return JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath });
}

function makeTranscript(tokenCounts = [{ input_tokens: 10, output_tokens: 5 }]) {
  return tokenCounts
    .map((u) =>
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: u,
        },
      })
    )
    .join('\n') + '\n';
}

// Fix #8: without ADVISOR_DEBUG, no debug log is written; token-usage still is
test('stop-telemetry: ADVISOR_DEBUG unset → no debug log, token-usage written', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(transcriptPath, makeTranscript());

  const result = spawnSync('node', [STOP_TELEMETRY], {
    input: makeInput(transcriptPath),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpDir,
      ADVISOR_DEBUG: '',
    },
  });

  expect(result.status).toBe(0);
  const debugLog = path.join(tmpDir, '.advisor', 'state', 'stop-hook-debug.jsonl');
  expect(fs.existsSync(debugLog)).toBe(false);
  const tokenLog = path.join(tmpDir, '.advisor', 'state', 'token-usage.jsonl');
  expect(fs.existsSync(tokenLog)).toBe(true);
});

// Fix #8: with ADVISOR_DEBUG=1, debug log is written
test('stop-telemetry: ADVISOR_DEBUG=1 → debug log written', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, makeTranscript());

  const result = spawnSync('node', [STOP_TELEMETRY], {
    input: makeInput(transcriptPath),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpDir,
      ADVISOR_DEBUG: '1',
    },
  });

  expect(result.status).toBe(0);
  const debugLog = path.join(tmpDir, '.advisor', 'state', 'stop-hook-debug.jsonl');
  expect(fs.existsSync(debugLog)).toBe(true);
  const lines = fs.readFileSync(debugLog, 'utf8').trim().split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
});

function runHook(tmpDir, transcriptPath, sessionId = 'test-sid-001') {
  const result = spawnSync('node', [STOP_TELEMETRY], {
    input: makeInput(transcriptPath, sessionId),
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpDir, ADVISOR_DEBUG: '' },
  });
  expect(result.status).toBe(0);
  const tokenLog = path.join(tmpDir, '.advisor', 'state', 'token-usage.jsonl');
  const rows = fs.readFileSync(tokenLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return rows[rows.length - 1];
}

test('stop-telemetry: repeated message.id counted once (dedupe-v2)', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: { role: 'assistant', id: 'msg_abc', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
  });
  // 3 content-block lines repeating the same message.id/usage.
  fs.writeFileSync(transcriptPath, [line, line, line].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(row.counting).toBe('dedupe-v2');
  expect(row.total_used).toBe(15);
  expect(row.breakdown.input_tokens).toBe(10);
  expect(row.breakdown.output_tokens).toBe(5);
  expect(row.by_model['claude-sonnet-5'].input_tokens).toBe(10);
});

test('stop-telemetry: <synthetic> model message is ignored', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const synthetic = JSON.stringify({
    message: { role: 'assistant', id: 'msg_synth', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } },
  });
  const real = JSON.stringify({
    message: { role: 'assistant', id: 'msg_real', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
  });
  fs.writeFileSync(transcriptPath, [synthetic, real].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(row.total_used).toBe(15);
  expect(row.by_model['<synthetic>']).toBeUndefined();
});

test('stop-telemetry: two-model transcript produces two by_model entries with 5m/1h split', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const modelA = JSON.stringify({
    message: {
      role: 'assistant', id: 'msg_a', model: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 } },
    },
  });
  const modelB = JSON.stringify({
    message: {
      role: 'assistant', id: 'msg_b', model: 'claude-haiku-4-5',
      usage: { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 4 },
    },
  });
  fs.writeFileSync(transcriptPath, [modelA, modelB].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(Object.keys(row.by_model).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  expect(row.by_model['claude-sonnet-5'].cache_creation_5m_input_tokens).toBe(3);
  expect(row.by_model['claude-sonnet-5'].cache_creation_1h_input_tokens).toBe(7);
  // No usage.cache_creation object -> all counted as 5m.
  expect(row.by_model['claude-haiku-4-5'].cache_creation_5m_input_tokens).toBe(4);
  expect(row.by_model['claude-haiku-4-5'].cache_creation_1h_input_tokens).toBe(0);
  expect(row.breakdown.cache_creation_input_tokens).toBe(3 + 7 + 4);
});

test('stop-telemetry: advisor_message iteration folds into by_model[iteration.model], tagged dedupe-v3, repeated message.id not double-counted', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: {
      role: 'assistant', id: 'msg_advisor', model: 'claude-sonnet-5',
      usage: {
        input_tokens: 10, output_tokens: 5,
        iterations: [
          { type: 'message', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5 },
          {
            type: 'advisor_message', model: 'claude-opus-5',
            input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2,
            cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 },
          },
        ],
      },
    },
  });
  // Same message.id repeated (one JSONL line per content block) must not double-count.
  fs.writeFileSync(transcriptPath, [line, line].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(row.counting).toBe('dedupe-v3');
  expect(Object.keys(row.by_model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  expect(row.by_model['claude-opus-5'].input_tokens).toBe(100);
  expect(row.by_model['claude-opus-5'].output_tokens).toBe(50);
  expect(row.by_model['claude-sonnet-5'].input_tokens).toBe(10);
  expect(row.breakdown.input_tokens).toBe(110); // 10 executor + 100 advisor, each counted once
});

test('stop-telemetry: transcript over 1000 lines is counted in full', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const linesArr = [];
  for (let i = 0; i < 1200; i++) {
    linesArr.push(JSON.stringify({
      message: { role: 'assistant', id: `msg_${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 } },
    }));
  }
  fs.writeFileSync(transcriptPath, linesArr.join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(row.total_used).toBe(1200 * 2);
});

function haikuLine(id, model, usage) {
  return JSON.stringify({ message: { role: 'assistant', id, model, usage } });
}

test('stop-telemetry: haiku-5-5 prompt <=100000 stays on the plain key; >100000 goes to :long (boundary)', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    haikuLine('h_below', 'claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1, cache_read_input_tokens: 49999 }),
    haikuLine('h_at', 'claude-haiku-5-5', { input_tokens: 40000, output_tokens: 2, cache_read_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 20000, ephemeral_1h_input_tokens: 10000 } }),
    haikuLine('h_above', 'claude-haiku-5-5', { input_tokens: 40000, output_tokens: 4, cache_read_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 20000, ephemeral_1h_input_tokens: 10001 } }),
  ].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(Object.keys(row.by_model).sort()).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5:long']);
  expect(row.by_model['claude-haiku-5-5'].input_tokens).toBe(90000);
  expect(row.by_model['claude-haiku-5-5'].output_tokens).toBe(3);
  expect(row.by_model['claude-haiku-5-5'].cache_creation_1h_input_tokens).toBe(10000);
  expect(row.by_model['claude-haiku-5-5:long']).toEqual({
    input_tokens: 40000, output_tokens: 4, cache_read_input_tokens: 30000,
    cache_creation_5m_input_tokens: 20000, cache_creation_1h_input_tokens: 10001,
  });
  // Session totals unchanged by the split.
  expect(row.breakdown.input_tokens).toBe(130000);
  expect(row.total_used).toBe(50000 + 1 + 49999 + 40000 + 2 + 30000 + 30000 + 40000 + 4 + 30000 + 30001);
});

test('stop-telemetry: dated haiku-5-5 snapshot normalizes; repeated message.id counted once', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const big = haikuLine('h_dated', 'claude-haiku-5-5-20260101', { input_tokens: 100001, output_tokens: 3 });
  fs.writeFileSync(transcriptPath, [big, big].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(Object.keys(row.by_model)).toEqual(['claude-haiku-5-5:long']);
  expect(row.by_model['claude-haiku-5-5:long'].input_tokens).toBe(100001);
});

test('stop-telemetry: claude-haiku-4-5 and other models are never split, even with huge prompts', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    haikuLine('a', 'claude-haiku-4-5', { input_tokens: 500000, output_tokens: 1 }),
    haikuLine('b', 'claude-haiku-4-5-20251001', { input_tokens: 500000, output_tokens: 1 }),
    haikuLine('c', 'claude-sonnet-5', { input_tokens: 500000, output_tokens: 1 }),
    haikuLine('d', 'claude-opus-5-5', { input_tokens: 500000, output_tokens: 1 }),
  ].join('\n') + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(Object.keys(row.by_model).sort()).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-5']);
});

test('stop-telemetry: haiku-5-5 advisor_message iteration is split on its own prompt size', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, haikuLine('x', 'claude-sonnet-5', {
    input_tokens: 10, output_tokens: 1,
    iterations: [{ type: 'advisor_message', model: 'claude-haiku-5-5', input_tokens: 100001, output_tokens: 2 }],
  }) + '\n');

  const row = runHook(tmpDir, transcriptPath);
  expect(row.by_model['claude-haiku-5-5:long'].input_tokens).toBe(100001);
  expect(row.by_model['claude-haiku-5-5']).toBeUndefined();
});
