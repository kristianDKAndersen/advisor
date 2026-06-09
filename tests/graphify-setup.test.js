import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(REPO, 'lib', 'graphify-setup.sh');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-setup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFakeGraphify(logFile, exitCodeOnUpdate = 0) {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'graphify');
  const failLogic = exitCodeOnUpdate !== 0
    ? `if [[ "$1" == "update" ]]; then exit ${exitCodeOnUpdate}; fi`
    : '';
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash\necho "graphify $*" >> ${JSON.stringify(logFile)}\n${failLogic}\nexit 0\n`
  );
  fs.chmodSync(bin, 0o755);
  return binDir;
}

function runWithGraphify(logFile, exitCodeOnUpdate = 0) {
  const binDir = makeFakeGraphify(logFile, exitCodeOnUpdate);
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: tmpDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    timeout: 10000,
  });
}

test('T1: graphify not on PATH prints install hint and exits 0', () => {
  // Use an empty bin dir so no graphify is found.
  // Use absolute /bin/bash so spawnSync can resolve bash even with a stripped PATH.
  const emptyBin = path.join(tmpDir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const r = spawnSync('/bin/bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: tmpDir,
    env: { ...process.env, PATH: emptyBin },
    timeout: 10000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('npm install -g @graphify/cli');
});

test('T2: graphify present calls graphify update . --no-cluster', () => {
  const logFile = path.join(tmpDir, 'calls.log');
  runWithGraphify(logFile);
  const calls = fs.readFileSync(logFile, 'utf8');
  expect(calls).toContain('update . --no-cluster');
});

test('T3: graphify present calls graphify hook install', () => {
  const logFile = path.join(tmpDir, 'calls.log');
  runWithGraphify(logFile);
  const calls = fs.readFileSync(logFile, 'utf8');
  expect(calls).toContain('hook install');
});

test('T4: both graphify calls happen in order (update before hook install)', () => {
  const logFile = path.join(tmpDir, 'calls.log');
  runWithGraphify(logFile);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  const updateIdx = lines.findIndex((l) => l.includes('update'));
  const installIdx = lines.findIndex((l) => l.includes('hook install'));
  expect(updateIdx).toBeGreaterThanOrEqual(0);
  expect(installIdx).toBeGreaterThanOrEqual(0);
  expect(updateIdx).toBeLessThan(installIdx);
});

test('T5: successful run exits 0', () => {
  const logFile = path.join(tmpDir, 'calls.log');
  const r = runWithGraphify(logFile);
  expect(r.status).toBe(0);
});

test('T6: graphify update failure causes non-zero exit (set -euo pipefail active)', () => {
  const logFile = path.join(tmpDir, 'calls.log');
  const r = runWithGraphify(logFile, 1);
  expect(r.status).not.toBe(0);
});
