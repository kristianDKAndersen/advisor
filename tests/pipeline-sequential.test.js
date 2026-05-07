import { test, expect, mock, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Created at module load time — mock.module must intercept child_process
// before lib/pipeline.js is first imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-seq-test-'));
const calls = []; // recorded { cmd, args } per execFileSync invocation

mock.module('child_process', () => ({
  execFileSync: (cmd, args, _opts) => {
    calls.push({ cmd, args: Array.isArray(args) ? [...args] : args });
    const idx = calls.length - 1;
    const sid = `fake-pipe-${idx}`;
    const dir = path.join(tmpDir, sid);
    fs.mkdirSync(dir, { recursive: true });
    const outbox = path.join(dir, 'outbox.jsonl');
    const inbox = path.join(dir, 'inbox.jsonl');
    // Pre-populate worker outbox so pipeline polling loop terminates immediately.
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

// Helper: import runPipeline — returns undefined if module absent or export missing.
async function loadRunPipeline() {
  try {
    const mod = await import(path.resolve(import.meta.dir, '../lib/pipeline.js'));
    return mod.runPipeline;
  } catch (_) {
    return undefined;
  }
}

// U3-1: runPipeline named export exists
test('runPipeline is a named export of lib/pipeline.js', async () => {
  const runPipeline = await loadRunPipeline();
  // RED: lib/pipeline.js does not exist yet → runPipeline is undefined
  expect(typeof runPipeline).toBe('function');
});

// U3-2: Single-step pipeline returns PipelineReport with full nested shape
test('runPipeline returns PipelineReport with full shape for a single-step pipeline', async () => {
  const runPipeline = await loadRunPipeline();

  const pipeline = {
    name: 'example',
    steps: [{ agent: 'researcher', task_template: 'step0', goal_template: 'g0' }],
  };

  let report;
  try {
    report = await runPipeline(pipeline, {});
  } catch (_) {
    report = {};
  }

  expect(report.name).toBe('example');
  expect(Array.isArray(report.steps)).toBe(true);
  expect(report.steps.length).toBe(1);

  const step = report.steps[0];
  expect(step.step_index).toBe(0);
  expect(typeof step.sid).toBe('string');
  expect(step.agent).toBe('researcher');
  expect(step.status).toBe('result');
  expect(step.summary).toBe('mock done');
  expect(step.verdict).toBe('complete');
  expect(typeof report.startedAt).toBe('string');
  expect(typeof report.endedAt).toBe('string');
});

// U3-3: Template substitution — step[1].task_template uses {{prev_summary}}
// The second execFileSync call's args must contain the substituted value 'Follow up on mock done'.
test('second step substitutes {{prev_summary}} with first step summary in summon args', async () => {
  // Reset recorded calls so indices are predictable for this test.
  calls.length = 0;

  const runPipeline = await loadRunPipeline();

  const pipeline = {
    name: 'two-step',
    steps: [
      { agent: 'researcher', task_template: 'initial task', goal_template: 'g0' },
      { agent: 'researcher', task_template: 'Follow up on {{prev_summary}}', goal_template: 'g1' },
    ],
  };

  try {
    await runPipeline(pipeline, {});
  } catch (_) {}

  // call[1] is the second summon invocation (step index 1).
  expect(calls.length).toBeGreaterThanOrEqual(2);
  const secondArgs = calls[1].args;
  const argsStr = Array.isArray(secondArgs) ? secondArgs.join(' ') : String(secondArgs);
  expect(argsStr).toContain('Follow up on mock done');
});
