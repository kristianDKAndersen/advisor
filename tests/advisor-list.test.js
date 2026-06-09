import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'advisor-list');

let tmpRunsDir;
let emptyRunsDir;

beforeAll(() => {
  tmpRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-list-test-'));
  emptyRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-list-empty-'));

  const sessions = [
    { sid: 'sid-A', agent: 'coder', repo: '/repos/alpha', task: 'fix bug', created_at: '2026-06-09T10:00:00.000Z' },
    { sid: 'sid-B', agent: 'researcher', repo: '/repos/beta', task: 'research X', created_at: '2026-06-09T09:00:00.000Z' },
    { sid: 'sid-C', agent: 'coder', repo: '/repos/alpha', task: 'add feature', created_at: '2026-06-09T08:00:00.000Z' },
  ];

  for (const s of sessions) {
    const dir = path.join(tmpRunsDir, s.sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(s));
  }
});

afterAll(() => {
  fs.rmSync(tmpRunsDir, { recursive: true, force: true });
  fs.rmSync(emptyRunsDir, { recursive: true, force: true });
});

function run(flags = [], runsDir = tmpRunsDir) {
  return spawnSync('bun', [BIN, ...flags], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: runsDir },
    timeout: 15000,
  });
}

test('T1: no flags prints text table with SID header and separator', () => {
  const r = run();
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('SID');
  expect(r.stdout).toContain('─');
});

test('T2: --json outputs valid JSON array of 3 sessions with sid and agent keys', () => {
  const r = run(['--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(3);
  expect(parsed[0]).toHaveProperty('sid');
  expect(parsed[0]).toHaveProperty('agent');
});

test('T3: --repo /repos/alpha filters to 2 sessions', () => {
  const r = run(['--json', '--repo', '/repos/alpha']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.length).toBe(2);
  expect(parsed.every((s) => s.repo === '/repos/alpha')).toBe(true);
});

test('T4: --agent coder filters to 2 sessions', () => {
  const r = run(['--json', '--agent', 'coder']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.length).toBe(2);
  expect(parsed.every((s) => s.agent === 'coder')).toBe(true);
});

test('T5: combined --repo --agent filters correctly', () => {
  const r1 = run(['--json', '--repo', '/repos/alpha', '--agent', 'researcher']);
  expect(r1.status).toBe(0);
  expect(JSON.parse(r1.stdout).length).toBe(0);

  const r2 = run(['--json', '--repo', '/repos/beta', '--agent', 'researcher']);
  expect(r2.status).toBe(0);
  expect(JSON.parse(r2.stdout).length).toBe(1);
});

test('T6: empty runs dir prints "No sessions found" and exits 0', () => {
  const r = run([], emptyRunsDir);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('No sessions found');
});
