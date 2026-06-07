import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// U19: synthesize CLI must write a checkpoint file at
// <ADVISOR_RUNS_ROOT>/<sid>/checkpoints/phase1-<ts>.json

const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');
const testSid = 'test-checkpoint-' + Date.now();

let tmpVault;
let tmpRuns;
let runDir;
let checkpointsDir;
let result;
let checkpointData;

beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ckpt-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-ckpt-'));
  runDir = path.join(tmpRuns, testSid);
  checkpointsDir = path.join(runDir, 'checkpoints');

  result = spawnSync(
    'bun',
    [
      LIB_CHANNEL, 'synthesize',
      '--sid', testSid,
      '--seq', '1',
      '--established', 'e',
      '--gap', 'g',
      '--material', 'no',
      '--next', 'n',
      '--key-quotes', 'q',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADVISOR_VAULT: tmpVault,
        ADVISOR_RUNS_ROOT: tmpRuns,
        ADVISOR_SKIP_TAB_CLOSE: '1',
      },
    }
  );

  checkpointData = null;
  try {
    const files = fs.readdirSync(checkpointsDir).filter(f => /^phase1-\d+\.json$/.test(f));
    if (files.length > 0) {
      checkpointData = JSON.parse(fs.readFileSync(path.join(checkpointsDir, files[0]), 'utf8'));
    }
  } catch (_) {}
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

test('synthesize exits 0', () => {
  expect(result.status).toBe(0);
});

test('checkpoints directory exists after synthesize', () => {
  expect(fs.existsSync(checkpointsDir)).toBe(true);
});

test('phase1-*.json checkpoint file exists in checkpoints dir', () => {
  const files = fs.readdirSync(checkpointsDir).filter(f => /^phase1-\d+\.json$/.test(f));
  expect(files.length).toBeGreaterThan(0);
});

test('checkpoint file parses as valid JSON object', () => {
  expect(checkpointData).not.toBeNull();
  expect(typeof checkpointData).toBe('object');
});

test('checkpoint r.sid is a string', () => {
  expect(typeof checkpointData.sid).toBe('string');
});

test('checkpoint r.seq is a number', () => {
  expect(typeof checkpointData.seq).toBe('number');
});

test('checkpoint r.phase is a number', () => {
  expect(typeof checkpointData.phase).toBe('number');
});

test('checkpoint r.phase === 1 (first synthesis)', () => {
  expect(checkpointData.phase).toBe(1);
});

test('checkpoint r.ts is a number', () => {
  expect(typeof checkpointData.ts).toBe('number');
});

test('checkpoint r.ts_iso is a string', () => {
  expect(typeof checkpointData.ts_iso).toBe('string');
});

test('checkpoint r.established is a string', () => {
  expect(typeof checkpointData.established).toBe('string');
});

test('checkpoint r.gap is a string', () => {
  expect(typeof checkpointData.gap).toBe('string');
});

test('checkpoint r.material is a string', () => {
  expect(typeof checkpointData.material).toBe('string');
});

test('checkpoint r.next_action is a string', () => {
  expect(typeof checkpointData.next_action).toBe('string');
});

test('checkpoint r.key_quotes is a string', () => {
  expect(typeof checkpointData.key_quotes).toBe('string');
});
