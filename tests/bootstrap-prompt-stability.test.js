'use strict';

// R2 prefix stability: the bootstrap prompt must be a per-agent-type CONSTANT.
// Two workers of the same agent type — different sids, paths, goals, hints —
// must receive a byte-identical bootstrap prompt (content[4] of the first API
// request), so the whole request prefix is shareable across same-type workers.
// Everything task-varying (goal, tool budget, discovery scaffolding, episodes)
// moves into the inbox task message instead (composeTaskBody).

const { test, expect, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { composeBootstrapPrompt, composeTaskBody } = require('../lib/summon');

const SUMMON_JS = path.resolve(__dirname, '../lib/summon.js');

function argsFor(sid) {
  return {
    sid,
    agentName: 'researcher',
    workspace: '/tmp/ws-' + sid,
    channelDir: '/tmp/chan-' + sid,
    outputDir: '/tmp/out-' + sid,
    advisorRoot: '/tmp/adv',
    repo: '/tmp/repo-' + sid,
    outputReason: sid.endsWith('1') ? 'self-invocation' : 'git-root',
    goal: 'unique goal for ' + sid,
    discoveryHint: sid.endsWith('1'),
  };
}

test('composeBootstrapPrompt: two sids, same agent type -> byte-identical prompt', () => {
  const a = composeBootstrapPrompt(argsFor('1700000001-aaaa1'));
  const b = composeBootstrapPrompt(argsFor('1700000002-bbbb2'));
  expect(a).toBe(b);
});

test('composeBootstrapPrompt: no per-worker values leak into the prompt text', () => {
  const sid = '1700000003-cccc3';
  const out = composeBootstrapPrompt(argsFor(sid));
  expect(out).not.toContain(sid);                       // no sid in header
  expect(out).not.toContain('/tmp/ws-' + sid);          // no workspace literal
  expect(out).not.toContain('/tmp/chan-' + sid);        // no channelDir literal
  expect(out).not.toContain('/tmp/out-' + sid);         // no outputDir literal
  expect(out).not.toContain('/tmp/repo-' + sid);        // no repo literal
  expect(out).not.toContain('unique goal for ' + sid);  // no goal block
  expect(out).toContain('researcher');                  // agent type may stay
  // task AND goal are announced as living in inbox seq 1
  expect(out).toMatch(/inbox seq 1[^\n]*goal/i);
});

test('composeTaskBody: carries task, goal, and tool budget', () => {
  const body = composeTaskBody({
    sid: '1700000004-dddd4',
    task: 'TASK_BRIEF_MARKER do the thing',
    goal: 'GOAL_MARKER done when X',
  });
  expect(body).toContain('TASK_BRIEF_MARKER do the thing');
  expect(body).toContain('GOAL_MARKER done when X');
  expect(body).toMatch(/budget of \d+ tool calls/);
});

// Integration: `node lib/summon.js` seeds inbox seq 1 with task + goal.
let tmpHome, tmpRuns;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-stab-home-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-stab-runs-'));
});
afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

test('summon seeds the inbox task message with the goal text', () => {
  const result = spawnSync('node', [
    SUMMON_JS,
    '--agent', 'researcher',
    '--task', 'R2 stability task brief',
    '--goal', 'R2_GOAL_SENTINEL: prompt is per-agent-type constant',
    '--isTestSession',
  ], {
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, HOME: tmpHome, ADVISOR_RUNS_ROOT: tmpRuns },
  });
  expect(result.status).toBe(0);
  const meta = JSON.parse(result.stdout);
  const first = JSON.parse(
    fs.readFileSync(meta.inbox, 'utf8').trim().split('\n')[0]
  );
  expect(first.type).toBe('task');
  expect(first.body).toContain('R2 stability task brief');
  expect(first.body).toContain('R2_GOAL_SENTINEL: prompt is per-agent-type constant');
  // ...and the goal must no longer be baked into the bootstrap prompt
  const prompt = fs.readFileSync(meta.promptFile, 'utf8');
  expect(prompt).not.toContain('R2_GOAL_SENTINEL');
  expect(prompt).not.toContain(meta.sid);
}, 30000);
