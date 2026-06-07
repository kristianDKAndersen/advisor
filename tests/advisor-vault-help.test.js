// Tests that every advisor-vault subcommand prints usage and exits 0 on --help/-h
// WITHOUT performing any DB or filesystem mutation.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BIN = path.resolve(import.meta.dir, '../bin/advisor-vault');

let tmpVault;

beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-help-'));
  // Write a fixture note that would be pruned if prune-fixtures actually runs
  fs.mkdirSync(path.join(tmpVault, 'synthesis'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpVault, 'synthesis', 'verdict-test-should-not-be-pruned.md'),
    '---\ntype: synthesis\nsid: helptest\n---\n\nThis file must survive a --help invocation.'
  );
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

function vaultRun(subcmd, extraArgs = []) {
  return spawnSync('bun', [BIN, subcmd, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVault },
    timeout: 10000,
  });
}

const DESTRUCTIVE = ['prune-fixtures', 'delete', 'rebuild', 'embed'];
const ALL_CMDS = [
  'search', 'backlinks', 'path', 'due', 'unresolved',
  'rebuild', 'embed', 'delete', 'hubs', 'gaps',
  'backfill-verdicts', 'retro-link', 'communities', 'prune-fixtures',
];

for (const cmd of ALL_CMDS) {
  test(`[HELP] ${cmd} --help exits 0 and prints Usage`, () => {
    const r = vaultRun(cmd, ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('usage');
  });

  test(`[HELP] ${cmd} -h exits 0 and prints Usage`, () => {
    const r = vaultRun(cmd, ['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('usage');
  });
}

test('[HELP] prune-fixtures --help does NOT prune the fixture note', () => {
  vaultRun('prune-fixtures', ['--help']);
  const noteFile = path.join(tmpVault, 'synthesis', 'verdict-test-should-not-be-pruned.md');
  expect(fs.existsSync(noteFile)).toBe(true);
});
