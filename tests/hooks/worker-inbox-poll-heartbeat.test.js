import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const WORKER_INBOX_POLL_SH = path.join(ADVISOR_ROOT, 'lib', 'hooks', 'worker-inbox-poll.sh');

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-poll-heartbeat-test-'));
});
afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('worker-inbox-poll.sh — heartbeat', () => {
  test('writes heartbeat.jsonl entry on each invocation', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'hb-'));
    const inbox = path.join(channelDir, 'inbox.jsonl');
    fs.writeFileSync(inbox, '');

    const result = spawnSync('bash', [WORKER_INBOX_POLL_SH], {
      encoding: 'utf8',
      env: { ...process.env, INBOX: inbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' }
    });

    expect(result.status).toBe(0);
    const hbFile = path.join(channelDir, 'heartbeat.jsonl');
    expect(fs.existsSync(hbFile)).toBe(true);
    const line = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim().split('\n').pop());
    expect(typeof line.ts).toBe('number');
    expect(line.ts).toBeGreaterThan(0);
    expect(typeof line.tool_count).toBe('number');
    expect(line.tool_count).toBeGreaterThanOrEqual(1);
  });

  test('tool_count increments on successive invocations', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'hb-inc-'));
    const inbox = path.join(channelDir, 'inbox.jsonl');
    fs.writeFileSync(inbox, '');

    const env = { ...process.env, INBOX: inbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' };
    spawnSync('bash', [WORKER_INBOX_POLL_SH], { encoding: 'utf8', env });
    spawnSync('bash', [WORKER_INBOX_POLL_SH], { encoding: 'utf8', env });
    spawnSync('bash', [WORKER_INBOX_POLL_SH], { encoding: 'utf8', env });

    const hbFile = path.join(channelDir, 'heartbeat.jsonl');
    const lines = fs.readFileSync(hbFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0].tool_count).toBe(1);
    expect(lines[1].tool_count).toBe(2);
    expect(lines[2].tool_count).toBe(3);
  });

  test('heartbeat failure does not break inbox poll exit code (fail-open)', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'hb-fail-'));
    const inbox = path.join(channelDir, 'inbox.jsonl');
    fs.writeFileSync(inbox, '');
    // Make heartbeat.jsonl a directory so appending to it fails
    fs.mkdirSync(path.join(channelDir, 'heartbeat.jsonl'));

    const result = spawnSync('bash', [WORKER_INBOX_POLL_SH], {
      encoding: 'utf8',
      env: { ...process.env, INBOX: inbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' }
    });

    expect(result.status).toBe(0);
  });

  test('heartbeat not written when ADVISOR_WORKER_HOOKS=0', () => {
    const channelDir = fs.mkdtempSync(path.join(tmpDir, 'hb-disabled-'));
    const inbox = path.join(channelDir, 'inbox.jsonl');
    fs.writeFileSync(inbox, '');

    spawnSync('bash', [WORKER_INBOX_POLL_SH], {
      encoding: 'utf8',
      env: { ...process.env, INBOX: inbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '0' }
    });

    const hbFile = path.join(channelDir, 'heartbeat.jsonl');
    expect(fs.existsSync(hbFile)).toBe(false);
  });
});
