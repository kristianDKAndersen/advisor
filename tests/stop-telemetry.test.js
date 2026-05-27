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
