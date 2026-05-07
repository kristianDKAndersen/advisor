// U6 Phase 5 Wave 1 — RED tests for skill content expansion (pattern 4.2).
// DoD: bun test exits 1 because provisionOne currently symlinks all skills unconditionally.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { provisionOne } from '../lib/summon.js';
import { mintSessionId } from '../lib/session.js';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const RUNS_ROOT = path.join(os.homedir(), '.advisor', 'runs');

const agentName = `test-skill-expand-${Date.now()}`;
const agentDir = path.join(ADVISOR_ROOT, 'agents', agentName);
const agentSkillsDir = path.join(agentDir, '.claude', 'skills');

const createdSids = [];

function prepareSession() {
  const sid = mintSessionId();
  const dir = path.join(RUNS_ROOT, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({
      schema_version: 2,
      sid,
      user_prompt: 'skill-expand test',
      tier: '',
      decomposition: [],
      decisions: [],
      next_action: ''
    }, null, 2)
  );
  createdSids.push(sid);
  return sid;
}

beforeAll(() => {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# Test agent for skill-expand tests\n');

  // Skill with shell expression in SKILL.md — wiring must expand it.
  const expandableDir = path.join(agentSkillsDir, 'expandable-skill');
  fs.mkdirSync(expandableDir, { recursive: true });
  fs.writeFileSync(path.join(expandableDir, 'SKILL.md'), '$(echo injected)');

  // Skill with no shell expressions — symlink must be left intact.
  const plainDir = path.join(agentSkillsDir, 'plain-skill');
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'SKILL.md'), 'plain content');
});

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  for (const sid of createdSids) {
    try { fs.rmSync(path.join(RUNS_ROOT, sid), { recursive: true, force: true }); } catch (_) {}
  }
});

// (1) After expansion the skill dir with $(...) must be materialized — not a symlink —
// so SKILL.md is a regular file at a stable workspace path.
test('expandable skill SKILL.md is a regular file (not a symlink) after expansion', () => {
  const sid = prepareSession();
  const meta = provisionOne({ agent: agentName, task: 'test', goal: 'test', cwd: ADVISOR_ROOT }, sid);
  const skillDir = path.join(meta.workspace, '.claude', 'skills', 'expandable-skill');
  expect(fs.lstatSync(skillDir).isSymbolicLink()).toBe(false);
});

// (2) Expansion must have evaluated the shell expression: file must contain the
// output ("injected") and must NOT contain the raw literal.
test('expandable SKILL.md contains expanded output and not the raw $(...) expression', () => {
  const sid = prepareSession();
  const meta = provisionOne({ agent: agentName, task: 'test', goal: 'test', cwd: ADVISOR_ROOT }, sid);
  const content = fs.readFileSync(
    path.join(meta.workspace, '.claude', 'skills', 'expandable-skill', 'SKILL.md'),
    'utf8'
  );
  expect(content).toContain('injected');
  expect(content).not.toContain('$(echo injected)');
});

// (3) Skills whose SKILL.md has no $(...) must be left as symlinks — no
// unnecessary copying.
test('plain skill dir remains a symlink when SKILL.md has no shell expressions', () => {
  const sid = prepareSession();
  const meta = provisionOne({ agent: agentName, task: 'test', goal: 'test', cwd: ADVISOR_ROOT }, sid);
  const plainLink = path.join(meta.workspace, '.claude', 'skills', 'plain-skill');
  expect(fs.lstatSync(plainLink).isSymbolicLink()).toBe(true);
});
