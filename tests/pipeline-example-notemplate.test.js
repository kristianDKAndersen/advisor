import { test, expect, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-notemplate-test-'));
const capturedCalls = [];

function fakeExecFileSync(cmd, args, _opts) {
  capturedCalls.push(Array.isArray(args) ? [...args] : []);
  const sid = `fake-notpl-${capturedCalls.length}`;
  const dir = path.join(tmpDir, sid);
  fs.mkdirSync(dir, { recursive: true });
  const outbox = path.join(dir, 'outbox.jsonl');
  fs.writeFileSync(
    outbox,
    JSON.stringify({
      ts: Date.now() / 1000,
      seq: 1,
      type: 'result',
      from: sid,
      body: JSON.stringify({ summary: 'stub done', paths: [], verdict: 'complete' }),
    }) + '\n'
  );
  fs.writeFileSync(path.join(dir, 'inbox.jsonl'), '');
  return JSON.stringify({ sid, outputDir: dir, outbox, inbox: path.join(dir, 'inbox.jsonl') });
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('example.json: no {{...}} template literal leaks into runPipeline summon args', async () => {
  const { runPipeline, loadPipeline } = await import(path.resolve(REPO_ROOT, 'lib/pipeline.js'));

  const pipeline = await loadPipeline('example', REPO_ROOT);
  expect(pipeline).not.toBeNull();

  capturedCalls.length = 0;
  await runPipeline(pipeline, {}, { execFileSync: fakeExecFileSync });

  expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
  const allArgs = capturedCalls.map((a) => a.join(' ')).join(' ');
  expect(allArgs).not.toMatch(/\{\{[^}]+\}\}/);
});
