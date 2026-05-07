import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const LIB_CHANNEL = path.resolve(import.meta.dir, '../lib/channel.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-channel-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Test 1: Round-trip — channel.append preserves full handoff message shape via readAfter.
// PASSES: channel.append is type-agnostic and round-trips arbitrary body objects.
test('channel.append with type handoff round-trips all fields via readAfter', async () => {
  const { append, readAfter } = await import(LIB_CHANNEL);
  const chanFile = path.join(tmpDir, 'handoff-roundtrip.jsonl');

  append(chanFile, {
    type: 'handoff',
    from: 'w1',
    body: { receiver_agent: 'planner', task: 'plan it', goal: 'plan done', context: null },
  });

  const msgs = readAfter(chanFile, 0);
  expect(msgs.length).toBeGreaterThanOrEqual(1);

  const rec = msgs.find((m) => m.type === 'handoff');
  expect(rec).not.toBeUndefined();
  expect(rec.type).toBe('handoff');
  expect(rec.from).toBe('w1');
  expect(typeof rec.seq).toBe('number');
  expect(rec.body.receiver_agent).toBe('planner');
  expect(rec.body.task).toBe('plan it');
  expect(rec.body.goal).toBe('plan done');
  expect(rec.body.context).toBeNull();
});

// Test 2: recv CLI must print 'HANDOFF REQUIRED' block for handoff messages.
// RED: recv does not yet handle type=handoff — this assertion will fail.
test('recv CLI on file with handoff message prints HANDOFF REQUIRED block', () => {
  const chanFile = path.join(tmpDir, 'handoff-cli.jsonl');

  fs.writeFileSync(
    chanFile,
    JSON.stringify({
      ts: Date.now() / 1000,
      seq: 1,
      type: 'handoff',
      from: 'w1',
      body: { receiver_agent: 'planner', task: 'plan it', goal: 'plan done', context: null },
    }) + '\n'
  );

  const result = spawnSync('bun', [LIB_CHANNEL, 'recv', '--file', chanFile, '--after', '0'], {
    encoding: 'utf8',
  });

  // RED: 'HANDOFF REQUIRED' is not yet emitted by recv — this fails until implemented.
  expect(result.stdout).toContain('HANDOFF REQUIRED');
});

// Test 3: recv CLI stdout must include field labels receiver_agent, task:, goal:.
// RED: recv currently formats body as raw JSON without labelled fields.
test('recv CLI on handoff message stdout includes receiver_agent, task:, goal: labels', () => {
  const chanFile = path.join(tmpDir, 'handoff-labels.jsonl');

  fs.writeFileSync(
    chanFile,
    JSON.stringify({
      ts: Date.now() / 1000,
      seq: 1,
      type: 'handoff',
      from: 'w1',
      body: { receiver_agent: 'planner', task: 'plan it', goal: 'plan done', context: null },
    }) + '\n'
  );

  const result = spawnSync('bun', [LIB_CHANNEL, 'recv', '--file', chanFile, '--after', '0'], {
    encoding: 'utf8',
  });

  expect(result.stdout).toContain('receiver_agent');
  expect(result.stdout).toContain('task:');
  expect(result.stdout).toContain('goal:');
});
