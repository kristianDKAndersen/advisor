import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// synthesize requires --integration-edits ('none' or a non-empty description of
// the Advisor's own hand edits) and stores it in the record and the vault note.

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const PARALLEL_JS = path.resolve(import.meta.dir, '../lib/parallel.js');

let tmpRuns;
let tmpVault;
let sid;

beforeEach(() => {
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-ie-'));
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ie-'));
  sid = 'ie-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
});

afterEach(() => {
  fs.rmSync(tmpRuns, { recursive: true, force: true });
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

function synth(extra) {
  return spawnSync('bun', [
    CHANNEL_JS, 'synthesize',
    '--sid', sid, '--seq', '1',
    '--established', 'e', '--gap', 'g', '--material', 'no',
    '--next', 'proceed-to-step-8',
    ...extra,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADVISOR_RUNS_ROOT: tmpRuns,
      ADVISOR_VAULT: tmpVault,
      ADVISOR_SKIP_TAB_CLOSE: '1',
    },
  });
}

function readRecord() {
  const log = path.join(tmpRuns, sid, 'synthesis.log');
  return JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
}

test('[IE1] omitting --integration-edits exits 1 and names the field', () => {
  const r = synth([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('integration-edits');
  expect(fs.existsSync(path.join(tmpRuns, sid, 'synthesis.log'))).toBe(false);
});

test('[IE2] "none" is stored as integration_edits: "none"', () => {
  const r = synth(['--integration-edits', 'none']);
  expect(r.status).toBe(0);
  expect(readRecord().integration_edits).toBe('none');
});

test('[IE3] a description is stored verbatim', () => {
  const text = 'lib/channel.js:431 widened guard; lib/vault.js:455 added key';
  const r = synth(['--integration-edits', text]);
  expect(r.status).toBe(0);
  expect(readRecord().integration_edits).toBe(text);
});

test('[IE4] the printed SYNTHESIS REQUIRED template contains the flag', () => {
  const dir = path.join(tmpRuns, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  const inbox = path.join(dir, 'outbox.jsonl');
  const r1 = spawnSync('bun', [
    CHANNEL_JS, 'send', '--file', inbox, '--type', 'result',
    '--body', '{"summary":"s","paths":[],"verdict":"complete"}',
    '--from', 'coder', '--quiet',
  ], { encoding: 'utf8', env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns, ADVISOR_VAULT: tmpVault } });
  expect(r1.status).toBe(0);
  const r = spawnSync('bun', [CHANNEL_JS, 'recv', '--file', inbox, '--after', '0'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns, ADVISOR_VAULT: tmpVault },
  });
  expect(r.stdout).toContain('SYNTHESIS REQUIRED');
  expect(r.stdout).toContain('--integration-edits');
});

test('[IE5] the vault note carries integration_edits', () => {
  const r = synth(['--integration-edits', 'lib/x.js:1 hand edit']);
  expect(r.status).toBe(0);
  const note = fs.readFileSync(path.join(tmpVault, 'synthesis', `${sid}-1.md`), 'utf8');
  expect(note).toMatch(/integration_edits:.*lib\/x\.js:1 hand edit/);
});

test('[IE6] empty-string and whitespace values exit 1 naming the field', () => {
  for (const v of ['', '   ', '\t\n']) {
    const r = synth(['--integration-edits', v]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('integration-edits');
  }
  expect(fs.existsSync(path.join(tmpRuns, sid, 'synthesis.log'))).toBe(false);
});

test('[IE7] lib/parallel.js SYNTHESIS template contains the flag', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  expect(src).toContain('--integration-edits');
});
