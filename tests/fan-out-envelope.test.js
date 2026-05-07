import { test, expect, mock, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Created at module load time so the mock.module factory can reference it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-out-test-'));
let _workerIdx = 0;

// Intercept child_process before parallel.js loads.
// Fake bin/summon: returns worker metadata and pre-populates the worker outbox
// with a result message so the runParallel polling loop terminates immediately.
mock.module('child_process', () => ({
  execFileSync: (_cmd, _args, _opts) => {
    const idx = _workerIdx++;
    const sid = `fake-w-${idx}`;
    const dir = path.join(tmpDir, sid);
    fs.mkdirSync(dir, { recursive: true });
    const outbox = path.join(dir, 'outbox.jsonl');
    const inbox = path.join(dir, 'inbox.jsonl');
    fs.writeFileSync(
      outbox,
      JSON.stringify({
        ts: Date.now() / 1000,
        seq: 1,
        type: 'result',
        from: sid,
        body: JSON.stringify({ summary: 'mock done', paths: [], verdict: 'complete' }),
      }) + '\n'
    );
    fs.writeFileSync(inbox, '');
    return JSON.stringify({ sid, outputDir: dir, outbox, inbox });
  },
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
}));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── U15-1: channel.append preserves task_group_id ───────────────────────────
//
// channel.append spreads `...msg` into the stored record, so arbitrary fields
// such as task_group_id must survive round-trip to the JSONL file.

test('channel.append with task_group_id:g1 writes record with task_group_id field "g1"', async () => {
  const { append, readAfter } = await import(path.resolve(import.meta.dir, '../lib/channel.js'));
  const chanFile = path.join(tmpDir, 'passthrough.jsonl');

  append(chanFile, { type: 'task', body: 'payload', from: 'tester', task_group_id: 'g1' });

  const msgs = readAfter(chanFile, 0);
  expect(msgs.length).toBeGreaterThanOrEqual(1);
  const rec = msgs.find((m) => m.task_group_id !== undefined);
  expect(rec).not.toBeUndefined();
  expect(typeof rec.task_group_id).toBe('string');
  expect(rec.task_group_id).toBe('g1');
});

// ── U15-2: runParallel with fanInGroups → report.groups (RED) ───────────────
//
// runParallel does NOT yet accept fanInGroups; report.groups will be undefined.
// This test is intentionally RED until U16 implements the fan-in feature.
// Expected failure: Array.isArray(undefined) === false  (expect(false).toBe(true)).
//
// Design note: runParallel spawns real worker processes via bin/summon, which will
// fail in a test environment. We catch any spawn error and normalize to {}, so the
// test always reaches the shape assertions. When the mock.module above begins
// intercepting child_process.execFileSync, runParallel will complete and the same
// assertions apply to the actual return value.

test('runParallel with fanInGroups option returns report.groups with fan-in-complete shape', async () => {
  const { runParallel } = await import(path.resolve(import.meta.dir, '../lib/parallel.js'));

  const briefs = [
    { agent: 'coder-worker', task: 'implement X', goal: 'ship it', task_group_id: 'g1' },
  ];

  let report;
  try {
    report = await runParallel(briefs, {
      fanInGroups: [{ task_group_id: 'g1', fan_in_threshold: 1 }],
      pollIntervalMs: 10,
      outputDir: path.join(tmpDir, 'report-out'),
    });
  } catch (_e) {
    // Spawn failure in test env — normalize so shape assertions run regardless.
    report = {};
  }

  // RED: report.groups is undefined because fanInGroups is not yet implemented.
  // Array.isArray(undefined) === false → expect(false).toBe(true) fails here.
  expect(Array.isArray(report.groups)).toBe(true);
  expect(report.groups.length).toBeGreaterThanOrEqual(1);

  const g = report.groups[0];
  expect(typeof g.task_group_id).toBe('string');
  expect(Array.isArray(g.worker_sids)).toBe(true);
  expect(g.worker_sids.every((sid) => typeof sid === 'string')).toBe(true);
  expect(g.status).toBe('fan-in-complete');
});
