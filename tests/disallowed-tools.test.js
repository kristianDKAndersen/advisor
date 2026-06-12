// R3 (static safe denylist): provisionOne must emit a --disallowedTools flag that
// strips advisor/harness-only tool schemas from every worker request, WITHOUT ever
// disallowing a tool a worker needs (Bash/Read/Skill/Agent/Edit/Write/Web*).
//
// The list is static and identical across agent types, so it never fragments the
// cross-worker prefix cache (R1+R2). Worst case on CLI tool renames is missed
// savings, never a broken worker — so there is no drift guard to test here.

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-disallow-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-disallow-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

function provision(agentName) {
  const sid = `test-disallow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = spawnSync(
    'node',
    [SUMMON_JS, '--agent', agentName, '--task', 'disallow test', '--goal', 'test', '--sid', sid],
    { encoding: 'utf8', env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP } }
  );
  if (result.status !== 0) throw new Error(`summon exited ${result.status}: ${result.stderr}`);
  const meta = JSON.parse(result.stdout.trim());
  return fs.readFileSync(meta.launchScript, 'utf8');
}

// researcher and creative exercise two shapes: a Bash-listing agent and one whose
// frontmatter omits Bash (creative: Read, Write). Neither must lose a needed tool.
const researcherLaunch = provision('researcher');
const creativeLaunch = provision('creative');

test('launch.sh emits a --disallowedTools flag', () => {
  expect(researcherLaunch).toContain('--disallowedTools ');
});

test('disallowed list strips the heavy harness tools (Workflow, Monitor, Cron*, Task*)', () => {
  for (const t of ['Workflow', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'AskUserQuestion']) {
    expect(researcherLaunch).toContain(t);
  }
});

test('NEVER disallows a tool any worker needs — for a Bash-listing agent (researcher)', () => {
  const m = researcherLaunch.match(/--disallowedTools '([^']*)'/);
  expect(m).not.toBeNull();
  const disallowed = m[1].split(',');
  for (const keep of ['Bash', 'Read', 'Skill', 'Agent', 'Edit', 'Write', 'WebFetch', 'WebSearch']) {
    expect(disallowed).not.toContain(keep);
  }
});

test('NEVER disallows Bash/Read/Skill even when frontmatter omits Bash (creative: Read, Write)', () => {
  const m = creativeLaunch.match(/--disallowedTools '([^']*)'/);
  expect(m).not.toBeNull();
  const disallowed = m[1].split(',');
  for (const keep of ['Bash', 'Read', 'Skill', 'Write']) {
    expect(disallowed).not.toContain(keep);
  }
});

test('the disallowed list is identical across agent types (no cache fragmentation)', () => {
  const r = researcherLaunch.match(/--disallowedTools '([^']*)'/)[1];
  const c = creativeLaunch.match(/--disallowedTools '([^']*)'/)[1];
  expect(r).toBe(c);
});
