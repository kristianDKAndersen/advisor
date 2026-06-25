import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const HOOK_PATH = path.join(ADVISOR_ROOT, 'lib', 'hooks', 'worker-result-check.js');

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-result-check-test-'));
});
afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('worker-result-check.js — Stop hook synthetic result', () => {
  test('appends no_verdict synthetic result when outbox has no result', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'ch-'));
    const outbox = path.join(channelDir, 'outbox.jsonl');
    fs.writeFileSync(outbox, JSON.stringify({ type: 'progress', body: 'working', from: 'coder', seq: 1, ts: Date.now() / 1000 }) + '\n');

    const result = spawnSync('node', [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, OUTBOX: outbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' }
    });

    expect(result.status).toBe(0);
    const lines = fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean);
    const resultMsg = lines.map(l => JSON.parse(l)).find(m => m.type === 'result');
    expect(resultMsg).toBeDefined();
    const body = typeof resultMsg.body === 'string' ? JSON.parse(resultMsg.body) : resultMsg.body;
    expect(body.verdict).toBe('no_verdict');
    expect(body.summary).toContain('without sending a result envelope');
    expect(resultMsg.from).toBe('worker-result-check');
  });

  test('does nothing when a result already exists', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'ch-exist-'));
    const outbox = path.join(channelDir, 'outbox.jsonl');
    const existingResult = { type: 'result', body: { verdict: 'complete', summary: 'done', paths: [] }, from: 'coder', seq: 2, ts: Date.now() / 1000 };
    fs.writeFileSync(outbox, JSON.stringify(existingResult) + '\n');
    const originalLines = fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).length;

    const result = spawnSync('node', [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, OUTBOX: outbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' }
    });

    expect(result.status).toBe(0);
    const newLines = fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).length;
    expect(newLines).toBe(originalLines);
  });

  test('exits 0 when OUTBOX env is not set (fail-open)', () => {
    const env = { ...process.env, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' };
    delete env.OUTBOX;
    const result = spawnSync('node', [HOOK_PATH], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
  });

  test('exits 0 when ADVISOR_WORKER_HOOKS=0 (disabled)', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'ch-disabled-'));
    const outbox = path.join(channelDir, 'outbox.jsonl');
    fs.writeFileSync(outbox, '');

    const result = spawnSync('node', [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, OUTBOX: outbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '0' }
    });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(outbox, 'utf8');
    expect(content.trim()).toBe('');
  });

  test('exits 0 on malformed outbox lines (fail-open)', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'ch-bad-'));
    const outbox = path.join(channelDir, 'outbox.jsonl');
    fs.writeFileSync(outbox, 'NOT VALID JSON\n{broken\n');

    const result = spawnSync('node', [HOOK_PATH], {
      encoding: 'utf8',
      env: { ...process.env, OUTBOX: outbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' }
    });
    expect(result.status).toBe(0);
  });
});
