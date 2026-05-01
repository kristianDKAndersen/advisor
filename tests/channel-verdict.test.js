import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const ADVISOR_RUNS = path.join(os.homedir(), '.advisor', 'runs');

// Create a unique sid for each test to avoid collision with synthesis.log entries
let tmpRunDir;

beforeAll(() => {
  fs.mkdirSync(path.join(ADVISOR_RUNS), { recursive: true });
});

afterAll(() => {
  // Clean up temp synthesis.log files created during tests
  if (tmpRunDir) fs.rmSync(tmpRunDir, { recursive: true, force: true });
});

function runSynthesize(args, sid) {
  // Each call uses a unique sid to avoid hasSynthesisRecord blocking reruns
  return spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize', '--sid', sid, '--seq', '99',
     '--established', 'test', '--gap', 'none', '--material', 'yes',
     '--next', 'proceed-to-step-8',
     ...args],
    { encoding: 'utf8' }
  );
}

// Scenario 4a: --verdict blocked --material yes → stdout CONTAINS LESSON EXTRACTION REQUIRED
test('synthesize --verdict blocked emits LESSON EXTRACTION REQUIRED block', () => {
  const sid = `verdict-test-blocked-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'blocked'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).toContain('synthesis recorded:');
});

// Scenario 4b: --verdict complete → stdout does NOT contain LESSON EXTRACTION REQUIRED
test('synthesize --verdict complete does NOT emit LESSON EXTRACTION block', () => {
  const sid = `verdict-test-complete-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'complete'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).toContain('synthesis recorded:');
});

// Scenario 8: no --verdict flag → succeeds, no block
test('synthesize without --verdict succeeds and does not emit LESSON EXTRACTION block', () => {
  const sid = `verdict-test-none-${Date.now()}`;
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
});

// Bonus: --verdict partial → no block
test('synthesize --verdict partial does NOT emit LESSON EXTRACTION block', () => {
  const sid = `verdict-test-partial-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'partial'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
});

// Block text: sid and seq are substituted correctly
test('LESSON EXTRACTION block contains runtime sid and seq values', () => {
  const sid = `verdict-test-vals-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'blocked'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`sid=${sid}`);
  expect(result.stdout).toContain('seq=99');
});
