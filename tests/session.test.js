import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let tmpVaultRoot;
let tmpRunsRoot;

beforeAll(() => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-vault-test-'));
  tmpRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-runs-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  process.env.ADVISOR_RUNS_ROOT = tmpRunsRoot;
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
  fs.rmSync(tmpRunsRoot, { recursive: true, force: true });
});

// G8: session note write must be synchronous
test('session note file exists synchronously after writeMeta completes', async () => {
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  const { writeMeta } = await import('../lib/session.js');
  const meta = { sid: 'SESS-SYNC-TEST', agent: 'test', repo: '/tmp', created_at: new Date().toISOString() };
  writeMeta(meta.sid, meta);
  const notePath = path.join(tmpVaultRoot, 'sessions', 'SESS-SYNC-TEST.md');
  expect(fs.existsSync(notePath)).toBe(true);
});
