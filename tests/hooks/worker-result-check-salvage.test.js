import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { classifySessionDir } from '../../lib/failure-classifier.js';

const ROOT = path.resolve(import.meta.dir, '../..');
const HOOK = path.join(ROOT, 'lib/hooks/worker-result-check.js');
const SID = '1700000000-fedcba';
const SUMMARY = 'worker exited without sending a result envelope';

let tmp;
let runsRoot;
let outputDir;
let runDir;
let outboxPath;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-result-salvage-')));
  runsRoot = path.join(tmp, 'runs');
  outputDir = path.join(tmp, 'output');
  runDir = path.join(runsRoot, SID);
  fs.mkdirSync(path.join(runDir, 'channel'), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ sid: SID, agent: 'coder', outputDir }));
  outboxPath = path.join(runDir, 'channel', 'outbox.jsonl');
  fs.writeFileSync(outboxPath, '');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runHook() {
  const r = spawnSync(process.execPath, [HOOK], {
    env: { ...process.env, ADV: ROOT, OUTBOX: outboxPath, ADVISOR_RUNS_ROOT: runsRoot, ADVISOR_WORKER_HOOKS: '1' },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  const msgs = fs.readFileSync(outboxPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const msg = msgs.filter(m => m.type === 'result').pop();
  return { msg, body: typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body };
}

test('Stop hook: salvaged outputDir yields no_verdict body with paths and salvaged:true', () => {
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  const { msg, body } = runHook();
  expect(msg.from).toBe('worker-result-check');
  expect(body.verdict).toBe('no_verdict');
  expect(body.summary).toBe(SUMMARY);
  expect(body.paths).toEqual([path.join(outputDir, 'review.md')]);
  expect(body.salvaged).toBe(true);
});

test('Stop hook: empty outputDir yields the plain body with no paths or salvaged key', () => {
  const { body } = runHook();
  expect(body).toEqual({ summary: SUMMARY, verdict: 'no_verdict' });
  expect('paths' in body).toBe(false);
  expect('salvaged' in body).toBe(false);
});

test('Stop hook: missing meta.json still appends the plain body', () => {
  fs.rmSync(path.join(runDir, 'meta.json'));
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  const { msg, body } = runHook();
  expect(msg.from).toBe('worker-result-check');
  expect(body).toEqual({ summary: SUMMARY, verdict: 'no_verdict' });
});

test('failure-classifier: salvage fields leave the no_verdict classification unchanged', () => {
  runHook();
  const plain = classifySessionDir(runDir);
  fs.writeFileSync(outboxPath, '');
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  runHook();
  const salvaged = classifySessionDir(runDir);
  expect(salvaged.category).toBe(plain.category);
});
