// Pins CB11 summon gates: review agents get a skeleton-first write sentence (M7a)
// and tier-scaled timeouts (M7b); worker task bodies on non-advisor repos point at
// the repo-rules digest (M8); worker hooks include publish-guard (M1h).

import { test, expect, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SUMMON_JS = path.join(ROOT, 'lib/summon.js');
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-gates-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-gates-home-'));
const REPO_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-gates-repo-'));
process.env.ADVISOR_RUNS_ROOT = RUNS_TMP;
const summon = require(SUMMON_JS);

execFileSync('git', ['init', '-q', REPO_TMP]);
execFileSync('git', ['-C', REPO_TMP, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
fs.writeFileSync(path.join(REPO_TMP, 'CONTRIBUTING.md'), '- Never use em-dashes.\n');
execFileSync('git', ['-C', REPO_TMP, 'add', 'CONTRIBUTING.md']);

afterAll(() => {
  for (const d of [RUNS_TMP, HOME_TMP, REPO_TMP]) fs.rmSync(d, { recursive: true, force: true });
});

const OLD_SENTENCE = 'Write deliverables in as few writes as practical';

function provision(agent, extraArgs, cwd) {
  const sid = `test-gates-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync('node', [SUMMON_JS, '--agent', agent, '--task', 'summon-gates test - ignore', '--goal', 'test', '--sid', sid, ...extraArgs], {
    encoding: 'utf8',
    cwd: cwd || ROOT,
    env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
  });
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  const meta = JSON.parse(r.stdout.trim());
  const inbox = fs.readFileSync(meta.inbox, 'utf8').trim().split('\n');
  return { meta, body: JSON.parse(inbox[0]).body, stderr: r.stderr };
}

test('code-reviewer task body has the skeleton sentence, not the few-writes one', () => {
  const body = summon.composeTaskBody({ sid: 'gates-none', task: 't', goal: 'g', agent: 'code-reviewer' });
  expect(body).toContain('skeleton');
  expect(body).not.toContain('as few writes');
});

test('coder task body is unchanged', () => {
  const body = summon.composeTaskBody({ sid: 'gates-none', task: 't', goal: 'g', agent: 'coder' });
  expect(body).toContain(OLD_SENTENCE);
  expect(body).not.toContain('skeleton');
  expect(body).toBe(summon.composeTaskBody({ sid: 'gates-none', task: 't', goal: 'g' }));
});

test('scaledReviewTimeout scales by tier', () => {
  expect(summon.scaledReviewTimeout('deep_research')).toBe(3000);
  expect(summon.scaledReviewTimeout('comparison')).toBe(2400);
  expect(summon.scaledReviewTimeout('fact')).toBe(1500);
  expect(summon.scaledReviewTimeout(undefined)).toBe(1500);
});

test('code-reviewer with tier deep_research gets 3000', () => {
  expect(provision('code-reviewer', ['--tier', 'deep_research']).meta.timeoutSec).toBe(3000);
});

test('code-reviewer with tier fact gets 1500', () => {
  expect(provision('code-reviewer', ['--tier', 'fact']).meta.timeoutSec).toBe(1500);
});

test('code-reviewer with explicit --timeoutSec 900 keeps 900', () => {
  expect(provision('code-reviewer', ['--tier', 'deep_research', '--timeoutSec', '900']).meta.timeoutSec).toBe(900);
});

test('researcher with tier deep_research gets 1500', () => {
  expect(provision('researcher', ['--tier', 'deep_research']).meta.timeoutSec).toBe(1500);
});

test('non-advisor repo task body contains the repo-rules digest path', () => {
  const { body } = provision('code-reviewer', [], REPO_TMP);
  expect(body).toContain('## Repo rules');
  const m = body.match(/Read (\S+conventions-digest\.md) before your first edit or finding; a written rule outranks local style\./);
  expect(m).not.toBeNull();
  expect(m[1].startsWith(HOME_TMP) || m[1].startsWith(fs.realpathSync(HOME_TMP))).toBe(true);
  expect(fs.existsSync(m[1])).toBe(true);
});

test('advisor repo task body has no Repo rules section', () => {
  expect(provision('code-reviewer', [], ROOT).body).not.toContain('## Repo rules');
});

test('researcher on a non-advisor repo gets no Repo rules section', () => {
  expect(provision('researcher', [], REPO_TMP).body).not.toContain('## Repo rules');
});

test('digest generation failure warns and does not throw', () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-gates-norepo-'));
  try {
    expect(summon.repoRulesDigest('coder', notRepo, 'git-root')).toBeNull();
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
  }
});

test('worker hooks contain publish-guard on Bash', () => {
  const pre = summon.injectWorkerHooks({}).PreToolUse;
  expect(pre).toContainEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node $ADV/lib/hooks/publish-guard.js' }] });
});
