import { test, expect, mock, beforeEach, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-receiver-test-'));
const SUMMON_BIN = path.resolve(import.meta.dir, '../bin/summon');
const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');
const LIB_HANDOFF_RECEIVER = path.resolve(import.meta.dir, '../lib/handoff-receiver.js');

// Shared mutable state — reset per test via beforeEach.
const callLog = { calls: [], nextSid: 'test-sid-001' };

// Intercept child_process before lib/handoff-receiver.js loads so that
// execFileSync calls to bin/summon are captured without spawning a real process.
mock.module('child_process', () => ({
  execFileSync: (cmd, args, opts) => {
    callLog.calls.push({ cmd, args, opts });
    const sid = callLog.nextSid;
    return JSON.stringify({
      sid,
      outputDir: tmpDir,
      outbox: path.join(tmpDir, `${sid}-outbox.jsonl`),
      inbox: path.join(tmpDir, `${sid}-inbox.jsonl`),
    });
  },
}));

beforeEach(() => {
  callLog.calls = [];
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: processHandoff is a named export ─────────────────────────────────
// RED: lib/handoff-receiver.js does not exist — import will throw.
test('processHandoff is a named export from lib/handoff-receiver.js', async () => {
  const mod = await import(LIB_HANDOFF_RECEIVER);
  expect(typeof mod.processHandoff).toBe('function');
});

// ── Test 2: execFileSync called with SUMMON_BIN and expected flag args ────────
// RED: lib/handoff-receiver.js does not exist.
test('processHandoff calls execFileSync with SUMMON_BIN and args --agent planner --task plan X --goal plan done', async () => {
  callLog.nextSid = 'test-sid-002';
  const { processHandoff } = await import(LIB_HANDOFF_RECEIVER);
  const senderOutbox = path.join(tmpDir, 'sender-outbox-test2.jsonl');
  const handoffBody = { receiver_agent: 'planner', task: 'plan X', goal: 'plan done', context: null };

  await processHandoff(handoffBody, senderOutbox);

  expect(callLog.calls.length).toBeGreaterThanOrEqual(1);
  const call = callLog.calls[0];
  expect(call.cmd).toBe(SUMMON_BIN);
  expect(call.args).toContain('--agent');
  expect(call.args).toContain('planner');
  expect(call.args).toContain('--task');
  expect(call.args).toContain('plan X');
  expect(call.args).toContain('--goal');
  expect(call.args).toContain('plan done');
});

// ── Test 3: Returns full shape {sid: string, agent: 'planner'} ───────────────
// RED: lib/handoff-receiver.js does not exist.
test('processHandoff returns {sid: string with length > 0, agent: planner}', async () => {
  callLog.nextSid = 'test-sid-003';
  const { processHandoff } = await import(LIB_HANDOFF_RECEIVER);
  const senderOutbox = path.join(tmpDir, 'sender-outbox-test3.jsonl');
  const handoffBody = { receiver_agent: 'planner', task: 'plan X', goal: 'plan done', context: null };

  const result = await processHandoff(handoffBody, senderOutbox);

  expect(typeof result.sid).toBe('string');
  expect(result.sid.length).toBeGreaterThan(0);
  expect(result.agent).toBe('planner');
});

// ── Test 4: senderOutbox gets guidance record containing new worker's sid ─────
// RED: lib/handoff-receiver.js does not exist.
test('processHandoff appends guidance record to senderOutbox with new worker sid in body', async () => {
  callLog.nextSid = 'test-sid-004';
  const { processHandoff } = await import(LIB_HANDOFF_RECEIVER);
  const { readAfter } = await import(LIB_CHANNEL);
  const senderOutbox = path.join(tmpDir, 'sender-outbox-test4.jsonl');
  const handoffBody = { receiver_agent: 'planner', task: 'plan X', goal: 'plan done', context: null };

  const result = await processHandoff(handoffBody, senderOutbox);

  const msgs = readAfter(senderOutbox, 0);
  const guidance = msgs.find((m) => m.type === 'guidance');
  expect(guidance).not.toBeUndefined();
  expect(guidance.type).toBe('guidance');
  expect(typeof guidance.body).toBe('string');
  expect(guidance.body).toContain(result.sid);
});

// ── Test 5: context.prev_summary included in summon --task arg ────────────────
// RED: lib/handoff-receiver.js does not exist.
test('processHandoff with context {prev_summary:foo} passes prev_summary substring in summon --task value', async () => {
  callLog.nextSid = 'test-sid-005';
  const { processHandoff } = await import(LIB_HANDOFF_RECEIVER);
  const senderOutbox = path.join(tmpDir, 'sender-outbox-test5.jsonl');
  const handoffBody = {
    receiver_agent: 'planner',
    task: 'plan X',
    goal: 'plan done',
    context: { prev_summary: 'foo', prev_paths: ['/a'], prev_verdict: 'complete' },
  };

  await processHandoff(handoffBody, senderOutbox);

  expect(callLog.calls.length).toBeGreaterThanOrEqual(1);
  const call = callLog.calls[0];
  const taskIdx = call.args.indexOf('--task');
  expect(taskIdx).toBeGreaterThanOrEqual(0);
  const taskValue = call.args[taskIdx + 1];
  expect(taskValue).toContain('foo');
});
