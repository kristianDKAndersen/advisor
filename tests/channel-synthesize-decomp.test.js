import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;

let tmpVault;
let tmpRuns;
const createdSids = [];

beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-decomp-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-decomp-'));
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

afterEach(() => {
  for (const sid of createdSids.splice(0)) {
    const dir = path.join(tmpRuns, sid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runSynthesize(sid, extraArgs = []) {
  return spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize',
     '--sid', sid,
     '--seq', '5',
     '--established', 'the fix works',
     '--gap', 'none',
     '--material', 'yes',
     '--next', 'proceed',
     ...extraArgs],
    {
      encoding: 'utf8',
      timeout: 25000,
      env: { ...process.env, ADVISOR_VAULT: tmpVault, ADVISOR_RUNS_ROOT: tmpRuns, ADVISOR_SKIP_TAB_CLOSE: '1' },
    }
  );
}

function readSessionState(sid) {
  const p = path.join(tmpRuns, sid, 'session.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Regression test for H3: when decomposition is empty, synthesize must persist
// a new entry with synthesis_seq and status into session.json.
test('synthesize on empty decomposition persists new entry to session.json', () => {
  const sid = `decomp-empty-${Date.now()}`;
  createdSids.push(sid);

  const result = runSynthesize(sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('synthesis recorded:');

  const state = readSessionState(sid);
  expect(state.decomposition).toBeDefined();
  expect(state.decomposition.length).toBeGreaterThan(0);

  const entry = state.decomposition.find(d => d.synthesis_seq === 5);
  expect(entry).toBeDefined();
  expect(entry.synthesis_seq).toBe(5);
  expect(entry.status).toBe('complete');
}, TEST_TIMEOUT);

// When decomposition already has entries with synthesis_seq set, synthesize must
// push a new entry rather than silently losing the update.
test('synthesize when all existing entries are already synthesized pushes a new entry', () => {
  const sid = `decomp-full-${Date.now()}`;
  createdSids.push(sid);

  // Pre-seed session state with one already-synthesized entry.
  const runDir = path.join(tmpRuns, sid);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'session.json'),
    JSON.stringify({
      schema_version: 2,
      sid,
      user_prompt: '',
      tier: '',
      decomposition: [{ role: 'coder', scope: 'fix', status: 'complete', synthesis_seq: 1 }],
      decisions: [],
      next_action: '',
    }, null, 2)
  );

  // --seq 5 from helper, then --seq 99 overrides via last-value-wins in parseArgs
  const result = runSynthesize(sid, ['--seq', '99']);
  expect(result.status).toBe(0);

  const state = readSessionState(sid);
  const newEntry = state.decomposition.find(d => d.synthesis_seq === 99);
  expect(newEntry).toBeDefined();
  expect(newEntry.status).toBe('complete');
}, TEST_TIMEOUT);
