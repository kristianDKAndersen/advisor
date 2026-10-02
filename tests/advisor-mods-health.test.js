import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'advisor-mods-health');

let storeDir;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-mods-health-test-'));
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function writeStore(name, data) {
  fs.writeFileSync(path.join(storeDir, name), JSON.stringify(data));
}

function run(flags = [], dir = storeDir) {
  return spawnSync('bun', [BIN, '--store-dir', dir, ...flags], {
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('T1: age exactly at --stale-after boundary (90s) classifies OK', () => {
  const now = Date.now();
  writeStore('canary_inline-aaa.json', {
    'hb:boundary-ok': { ts: now - 90_000, startedAt: now - 1000, beats: 3, reloads: 0, registered: {}, cwd: '/work' },
  });
  const r = run(['--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.length).toBe(1);
  expect(parsed[0].status).toBe('OK');
});

test('T2: age just past --stale-after boundary (91s) classifies STALE and exits 3', () => {
  const now = Date.now();
  writeStore('canary_inline-bbb.json', {
    'hb:boundary-stale': { ts: now - 91_000, startedAt: now - 1000, beats: 3, reloads: 0, registered: {}, cwd: '/work' },
  });
  const r = run(['--json']);
  expect(r.status).toBe(3);
  const parsed = JSON.parse(r.stdout);
  expect(parsed[0].status).toBe('STALE');
});

test('T3: --json shape includes computed status and ageMs', () => {
  const now = Date.now();
  writeStore('canary_inline-ccc.json', {
    'hb:shape': { ts: now - 1000, startedAt: now - 5000, beats: 2, reloads: 1, registered: { foo: 1 }, cwd: '/x' },
  });
  const r = run(['--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed[0]).toHaveProperty('status');
  expect(parsed[0]).toHaveProperty('ageMs');
  expect(parsed[0]).toHaveProperty('sessionId', 'shape');
  expect(typeof parsed[0].ageMs).toBe('number');
});

test('T4: exit code 0 when no STALE records', () => {
  const now = Date.now();
  writeStore('canary_inline-ddd.json', {
    'hb:healthy': { ts: now - 1000, startedAt: now, beats: 1, reloads: 0, registered: {}, cwd: '/x' },
  });
  const r = run(['--json']);
  expect(r.status).toBe(0);
});

test('T5: ENDED records older than 1h hidden by default, shown with --all', () => {
  const now = Date.now();
  writeStore('canary_inline-eee.json', {
    'hb:old-ended': { ts: now - 2 * 60 * 60 * 1000, endedAt: now - 2 * 60 * 60 * 1000, startedAt: now - 3 * 60 * 60 * 1000, beats: 5, reloads: 0, registered: {}, cwd: '/x' },
  });
  const r1 = run(['--json']);
  expect(r1.status).toBe(0);
  expect(JSON.parse(r1.stdout).length).toBe(0);

  const r2 = run(['--json', '--all']);
  expect(r2.status).toBe(0);
  const parsed = JSON.parse(r2.stdout);
  expect(parsed.length).toBe(1);
  expect(parsed[0].status).toBe('ENDED');
});

test('T6: corrupt store file is skipped with stderr warning, valid files still processed', () => {
  const now = Date.now();
  fs.writeFileSync(path.join(storeDir, 'canary_inline-corrupt.json'), '{ not valid json');
  writeStore('canary_inline-good.json', {
    'hb:ok-one': { ts: now - 1000, startedAt: now, beats: 1, reloads: 0, registered: {}, cwd: '/x' },
  });
  const r = run(['--json']);
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('canary_inline-corrupt.json');
  const parsed = JSON.parse(r.stdout);
  expect(parsed.length).toBe(1);
  expect(parsed[0].sessionId).toBe('ok-one');
});

test('T7: non-canary store file is ignored', () => {
  const now = Date.now();
  fs.writeFileSync(path.join(storeDir, 'otherplugin_inline-xxx.json'), JSON.stringify({ 'hb:ignored': { ts: now, beats: 1 } }));
  writeStore('canary_inline-fff.json', {
    'hb:only-this': { ts: now - 1000, startedAt: now, beats: 1, reloads: 0, registered: {}, cwd: '/x' },
  });
  const r = run(['--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.length).toBe(1);
  expect(parsed[0].sessionId).toBe('only-this');
});

test('T8: --help exits 0 and writes nothing to the store dir', () => {
  const before = fs.readdirSync(storeDir);
  const r = run(['--help']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Usage');
  const after = fs.readdirSync(storeDir);
  expect(after).toEqual(before);
});

test('T9: empty/missing store dir prints a one-line message and exits 0', () => {
  const r1 = run([], storeDir);
  expect(r1.status).toBe(0);
  expect(r1.stdout).toContain('no canary heartbeats found');

  const missing = path.join(storeDir, 'does-not-exist');
  const r2 = run([], missing);
  expect(r2.status).toBe(0);
  expect(r2.stdout).toContain('no canary heartbeats found');
});

test('T10: default table output includes session/status/age columns, newest first', () => {
  const now = Date.now();
  writeStore('canary_inline-ggg.json', {
    'hb:older': { ts: now - 10_000, startedAt: now - 20_000, beats: 1, reloads: 0, registered: {}, cwd: '/a' },
    'hb:newer': { ts: now - 1_000, startedAt: now - 20_000, beats: 2, reloads: 0, registered: {}, cwd: '/b' },
  });
  const r = run([]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('SESSION');
  expect(r.stdout).toContain('STATUS');
  const newerIdx = r.stdout.indexOf('newer');
  const olderIdx = r.stdout.indexOf('older');
  expect(newerIdx).toBeGreaterThan(-1);
  expect(olderIdx).toBeGreaterThan(newerIdx);
});

test('T11: exit code 3 with a STALE record present in table mode too', () => {
  const now = Date.now();
  writeStore('canary_inline-hhh.json', {
    'hb:stale-one': { ts: now - 200_000, startedAt: now - 300_000, beats: 1, reloads: 0, registered: {}, cwd: '/x' },
  });
  const r = run([]);
  expect(r.status).toBe(3);
});
