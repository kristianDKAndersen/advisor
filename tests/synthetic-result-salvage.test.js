import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { collectSalvagePaths } from '../lib/channel.js';
import { classifySessionDir } from '../lib/failure-classifier.js';

const ROOT = path.resolve(import.meta.dir, '..');
const CHANNEL_JS = path.join(ROOT, 'lib/channel.js');
const SID = '1700000000-abcdef';

let tmp;
let runsRoot;
let outputDir;
let runDir;
let outboxPath;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-salvage-')));
  runsRoot = path.join(tmp, 'runs');
  outputDir = path.join(tmp, 'output');
  runDir = path.join(runsRoot, SID);
  fs.mkdirSync(path.join(runDir, 'channel'), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ sid: SID, agent: 'code-reviewer', outputDir }));
  outboxPath = path.join(runDir, 'channel', 'outbox.jsonl');
  fs.writeFileSync(outboxPath, '');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function lastResult() {
  const msgs = fs.readFileSync(outboxPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const r = msgs.filter(m => m.type === 'result').pop();
  return { msg: r, body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body };
}

function ensureResult() {
  const r = spawnSync('bun', [CHANNEL_JS, 'ensure-result', '--file', outboxPath, '--exit-code', '1', '--reason', 'timeout', '--quiet'], {
    env: { ...process.env, ADVISOR_RUNS_ROOT: runsRoot },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return lastResult();
}

function sealViaRunner(multiplex) {
  fs.writeFileSync(path.join(runDir, 'launch.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'x');
  const script = `
    const { spawnHeadless } = require(${JSON.stringify(path.join(ROOT, 'lib/tmux-runner.js'))});
    spawnHeadless({
      sid: ${JSON.stringify(SID)}, agent: 'code-reviewer',
      launchScript: ${JSON.stringify(path.join(runDir, 'launch.sh'))},
      promptFile: ${JSON.stringify(path.join(runDir, 'prompt.txt'))},
      logFile: ${JSON.stringify(path.join(runDir, 'log.txt'))},
      execFn: () => { throw new Error('no tmux in test'); },
    }).then(() => process.exit(2), () => process.exit(0));
  `;
  const r = spawnSync('bun', ['-e', script], {
    env: {
      ...process.env,
      ADVISOR_RUNS_ROOT: runsRoot,
      HOME: tmp,
      ADVISOR_NO_REAPER: '1',
      ADVISOR_TMUX_MULTIPLEX: multiplex ? '1' : '0',
    },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return lastResult();
}

test('collectSalvagePaths: outputDir holding review.md yields its absolute path; ensure-result verdict unchanged', () => {
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  expect(collectSalvagePaths(outputDir)).toEqual([path.join(outputDir, 'review.md')]);

  const { body } = ensureResult();
  expect(body.paths).toEqual([path.join(outputDir, 'review.md')]);
  expect(body.salvaged).toBe(true);
  expect(body.verdict).toBe('blocked');
  expect(body.summary).toBe('worker exited without result (exit_code=1); reason=timeout');
});

test('collectSalvagePaths: empty outputDir yields no paths key and no salvaged flag', () => {
  expect(collectSalvagePaths(outputDir)).toEqual([]);
  expect(collectSalvagePaths(path.join(tmp, 'missing'))).toEqual([]);

  const { body } = ensureResult();
  expect('paths' in body).toBe(false);
  expect('salvaged' in body).toBe(false);
  expect(body.verdict).toBe('blocked');
});

test('collectSalvagePaths: sorted, recursive, excludes trace.jsonl, captures/** and .spec-self-check/**', () => {
  fs.mkdirSync(path.join(outputDir, 'captures'));
  fs.mkdirSync(path.join(outputDir, '.spec-self-check'));
  fs.mkdirSync(path.join(outputDir, 'deliverables', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'trace.jsonl'), '');
  fs.writeFileSync(path.join(outputDir, 'captures', 'a.log'), '');
  fs.writeFileSync(path.join(outputDir, '.spec-self-check', 'x.json'), '');
  fs.writeFileSync(path.join(outputDir, 'b.md'), '');
  fs.writeFileSync(path.join(outputDir, 'a.md'), '');
  fs.writeFileSync(path.join(outputDir, 'deliverables', 'lib', 'z.js'), '');
  expect(collectSalvagePaths(outputDir)).toEqual([
    path.join(outputDir, 'a.md'),
    path.join(outputDir, 'b.md'),
    path.join(outputDir, 'deliverables', 'lib', 'z.js'),
  ]);
});

test('failure-classifier still classifies a salvaged synthetic result', () => {
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  ensureResult();
  const v = classifySessionDir(runDir);
  expect(v.category).not.toBe('clean-result');
  expect(v.evidence).toContain('timeout');
});

test('tmux-runner legacy sealOutbox site carries salvage paths', () => {
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  const { body } = sealViaRunner(false);
  expect(body.paths).toEqual([path.join(outputDir, 'review.md')]);
  expect(body.salvaged).toBe(true);
  expect(body.verdict).toBe('blocked');
  expect(body.summary).toMatch(/^worker exited without result \(exit_code=unknown\); reason=/);
});

test('tmux-runner multiplex sealOutbox site carries salvage paths', () => {
  fs.writeFileSync(path.join(outputDir, 'review.md'), '# partial');
  const { body } = sealViaRunner(true);
  expect(body.paths).toEqual([path.join(outputDir, 'review.md')]);
  expect(body.salvaged).toBe(true);
  expect(body.verdict).toBe('blocked');
});
