import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;

let tmpVault;
let tmpRuns;

beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-verdict-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-verdict-'));
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

function runSynthesize(args, sid) {
  // Each call uses a unique sid to avoid hasSynthesisRecord blocking reruns
  return spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize', '--sid', sid, '--seq', '99',
     '--established', 'test', '--gap', 'none', '--material', 'yes',
     '--next', 'proceed-to-step-8',
     ...args],
    {
      encoding: 'utf8',
      timeout: 25000,
      env: {
        ...process.env,
        ADVISOR_VAULT: tmpVault,
        ADVISOR_RUNS_ROOT: tmpRuns,
        ADVISOR_SKIP_TAB_CLOSE: '1',
      },
    }
  );
}

// Scenario 4a: --verdict blocked --material yes → dead block removed; no LESSON EXTRACTION output
test('synthesize --verdict blocked does NOT emit LESSON EXTRACTION REQUIRED block', () => {
  const sid = `verdict-test-blocked-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'blocked'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).toContain('synthesis recorded:');
}, TEST_TIMEOUT);

// Scenario 4b: --verdict complete → stdout does NOT contain LESSON EXTRACTION REQUIRED
test('synthesize --verdict complete does NOT emit LESSON EXTRACTION block', () => {
  const sid = `verdict-test-complete-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'complete'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).toContain('synthesis recorded:');
}, TEST_TIMEOUT);

// Scenario 8: no --verdict flag → succeeds, no block
test('synthesize without --verdict succeeds and does not emit LESSON EXTRACTION block', () => {
  const sid = `verdict-test-none-${Date.now()}`;
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
}, TEST_TIMEOUT);

// Bonus: --verdict partial → no block
test('synthesize --verdict partial does NOT emit LESSON EXTRACTION block', () => {
  const sid = `verdict-test-partial-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'partial'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
}, TEST_TIMEOUT);

// Dead block deleted: --verdict blocked produces no LESSON EXTRACTION output regardless of sid/seq
test('synthesize --verdict blocked produces no LESSON EXTRACTION output', () => {
  const sid = `verdict-test-vals-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'blocked'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).not.toContain('extract-lesson');
}, TEST_TIMEOUT);
