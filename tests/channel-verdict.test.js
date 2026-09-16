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

// Seed persisted result envelopes into ADVISOR_RUNS_ROOT/<sid>/channel/outbox.jsonl,
// the exact layout synthesize reads at lib/channel.js persistOutboxPath.
function seedResults(sid, verdicts) {
  const dir = path.join(tmpRuns, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  const lines = verdicts.map((verdict, i) => JSON.stringify({
    seq: i + 1, type: 'result', from: 'coder', ts: Date.now() / 1000,
    body: { verdict, summary: 'test' },
  }));
  fs.writeFileSync(path.join(dir, 'outbox.jsonl'), lines.join('\n') + '\n');
}

function seedBlockedResults(sid, n) {
  seedResults(sid, Array(n).fill('blocked'));
}

// Scenario 4a: --verdict blocked --material yes → the --verdict CLI flag is ignored
// (never read into the nudge gate); no LESSON EXTRACTION output without a persisted
// blocked result envelope.
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

// --verdict CLI flag stays ignored: it produces no LESSON EXTRACTION output regardless
// of sid/seq. The trigger is the persisted worker verdict, not this flag.
test('synthesize --verdict blocked produces no LESSON EXTRACTION output', () => {
  const sid = `verdict-test-vals-${Date.now()}`;
  const result = runSynthesize(['--verdict', 'blocked'], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).not.toContain('extract-lesson');
}, TEST_TIMEOUT);

// Repaired guard: a 2nd persisted blocked result envelope DOES emit the nudge.
test('synthesize emits LESSON EXTRACTION on 2nd blocked worker verdict', () => {
  const sid = `verdict-2blk-${Date.now()}`;
  seedBlockedResults(sid, 2);
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).toContain('/extract-lesson');
  expect(result.stdout).toContain(sid);
}, TEST_TIMEOUT);

// The 1st blocked verdict alone is noise, not signal: no nudge yet.
test('synthesize does NOT emit LESSON EXTRACTION on the 1st blocked verdict', () => {
  const sid = `verdict-1blk-${Date.now()}`;
  seedBlockedResults(sid, 1);
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
}, TEST_TIMEOUT);

// Persisted complete/partial verdicts never emit the nudge, even 2+ of them.
test('synthesize does NOT emit LESSON EXTRACTION for persisted complete verdicts', () => {
  const sid = `verdict-complete-persisted-${Date.now()}`;
  seedResults(sid, ['complete', 'complete']);
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('LESSON EXTRACTION REQUIRED');
}, TEST_TIMEOUT);
