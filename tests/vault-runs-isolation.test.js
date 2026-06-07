// Test that vault and runs root resolution honors temp-dir env overrides so tests
// never write to production paths (~/.advisor/vault or ~/.advisor/runs).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');

let tmpVault;
let tmpRuns;

beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-iso-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-iso-'));
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

test('[ISO-1] channel.js synthesize routes synthesis.log to ADVISOR_RUNS_ROOT, not production', () => {
  const sid = 'iso-synth-' + Date.now();
  const result = spawnSync('bun', [CHANNEL_JS, 'synthesize',
    '--sid', sid,
    '--seq', '1',
    '--established', 'isolation test established',
    '--gap', 'none',
    '--material', 'no',
    '--next', 'proceed-to-step-8',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADVISOR_VAULT: tmpVault,
      ADVISOR_RUNS_ROOT: tmpRuns,
      ADVISOR_SKIP_TAB_CLOSE: '1',
    },
  });

  expect(result.status).toBe(0);

  const synthLog = path.join(tmpRuns, sid, 'synthesis.log');
  expect(fs.existsSync(synthLog)).toBe(true);

  const prodSynthLog = path.join(os.homedir(), '.advisor', 'runs', sid, 'synthesis.log');
  expect(fs.existsSync(prodSynthLog)).toBe(false);
});

test('[ISO-2] channel.js synthesize routes checkpoint dir to ADVISOR_RUNS_ROOT, not production', () => {
  const sid = 'iso-ckpt-' + Date.now();
  spawnSync('bun', [CHANNEL_JS, 'synthesize',
    '--sid', sid,
    '--seq', '1',
    '--established', 'checkpoint isolation test',
    '--gap', 'none',
    '--material', 'no',
    '--next', 'proceed-to-step-8',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADVISOR_VAULT: tmpVault,
      ADVISOR_RUNS_ROOT: tmpRuns,
      ADVISOR_SKIP_TAB_CLOSE: '1',
    },
  });

  const ckptDir = path.join(tmpRuns, sid, 'checkpoints');
  expect(fs.existsSync(ckptDir)).toBe(true);
  const files = fs.readdirSync(ckptDir).filter(f => /^phase\d+-\d+\.json$/.test(f));
  expect(files.length).toBeGreaterThan(0);

  const prodCkptDir = path.join(os.homedir(), '.advisor', 'runs', sid, 'checkpoints');
  expect(fs.existsSync(prodCkptDir)).toBe(false);
});

test('[ISO-3] vault.vaultRoot honors ADVISOR_VAULT env override', async () => {
  const savedVault = process.env.ADVISOR_VAULT;
  process.env.ADVISOR_VAULT = tmpVault;
  const vault = await import('../lib/vault.js');
  expect(vault.vaultRoot()).toBe(tmpVault);
  if (savedVault !== undefined) process.env.ADVISOR_VAULT = savedVault;
  else delete process.env.ADVISOR_VAULT;
});
