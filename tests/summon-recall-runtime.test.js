import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const vault = require('../lib/vault');

const ROOT = path.resolve(import.meta.dir, '..');
const TASK = 'Plan the payment gateway migration rollout for the billing service.';
const LESSON_HEADING = '## Prior lessons (auto-recall)';

// The runtime bin/summon uses for lib/summon.js, read from the script itself so
// this test follows the entrypoint instead of assuming bun or node.
function entrypointRuntime() {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'summon'), 'utf8');
  const m = src.match(/^META=\$\((\S+) "\$ROOT\/lib\/summon\.js"/m);
  if (!m) throw new Error('bin/summon: META=$(<runtime> "$ROOT/lib/summon.js" ...) line not found');
  return m[1];
}

let tmp;
let vaultRoot;
let runsRoot;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'summon-recall-rt-'));
  vaultRoot = path.join(tmp, 'vault');
  runsRoot = path.join(tmp, 'runs');
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
  process.env.ADVISOR_VAULT = vaultRoot;
});

afterEach(() => {
  delete process.env.ADVISOR_VAULT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedLesson() {
  vault.writeNote('lessons/rt-lesson.md', {
    type: 'lesson', sid: 'S-rt-lesson', agent: 'coder',
    created_at: new Date().toISOString(), task_type: 'coder', tags: 'payment gateway migration',
  }, [
    'Tags: payment gateway migration',
    '## Root cause\nThe payment gateway migration rollout skipped staging.',
    '## Heuristic\nStage the rt-lesson rollout behind a flag.',
    '## Evidence\nSynthesis seq: 1',
  ].join('\n\n'));
}

// Same runtime and args as bin/summon's provisioning step; HOME is redirected so
// the workspace-trust write never touches the real ~/.claude.json.
function runSummon(sid, runtime = entrypointRuntime()) {
  const res = spawnSync(runtime, [
    path.join(ROOT, 'lib', 'summon.js'),
    '--agent', 'researcher', '--task', TASK, '--goal', 'Rollout plan drafted', '--sid', sid,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      ADVISOR_VAULT: vaultRoot,
      ADVISOR_RUNS_ROOT: runsRoot,
      ADVISOR_NO_REAPER: '1',
    },
  });
  const meta = res.status === 0 ? JSON.parse(res.stdout) : null;
  const seed = meta ? fs.readFileSync(meta.inbox, 'utf8') : '';
  return { res, meta, seed };
}

test('summon entrypoint runtime injects lesson section', () => {
  seedLesson();
  const { res, seed } = runSummon('rt-inject');
  expect(res.status).toBe(0);
  expect(seed).toContain(LESSON_HEADING);
  expect(seed).toContain('rt-lesson');
});

test('summon entrypoint runtime writes recall telemetry row', () => {
  seedLesson();
  const { res } = runSummon('rt-telemetry');
  expect(res.status).toBe(0);
  const file = path.join(vaultRoot, '.cache', 'recall.jsonl');
  expect(fs.existsSync(file)).toBe(true);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const row = rows.find(r => r.sid === 'rt-telemetry');
  expect(row).toBeTruthy();
  expect(row.lessons.map(l => l.path)).toContain('lessons/rt-lesson.md');
});

// vault-recall swallows read errors itself, so the real throw that reaches
// summon's catch is the original one: bun:sqlite missing under node.
test('recall failure logs to stderr and summon still succeeds', () => {
  seedLesson();
  const { res, seed } = runSummon('rt-failopen', 'node');
  expect(res.status).toBe(0);
  expect(res.stderr).toMatch(/^\[summon\] vault auto-recall unavailable: .+/m);
  expect(seed.length).toBeGreaterThan(0);
  expect(seed).not.toContain(LESSON_HEADING);
});
