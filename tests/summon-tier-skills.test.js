// U5 Phase 5 Wave 1 — RED tests for tier-conditional skill injection (pattern 4.3).
// DoD: bun test exits 1 because provisionOne currently symlinks all skills unconditionally.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { provisionOne } from '../lib/summon.js';
import { mintSessionId } from '../lib/session.js';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const RUNS_ROOT = path.join(os.homedir(), '.advisor', 'runs');

const agentName = `test-tier-skills-${Date.now()}`;
const agentDir = path.join(ADVISOR_ROOT, 'spawns', agentName);
const agentSkillsDir = path.join(agentDir, '.claude', 'skills');

const createdSids = [];

// Write session.json into the session dir BEFORE provisionOne reads it.
function prepareSession(tier) {
  const sid = mintSessionId();
  const dir = path.join(RUNS_ROOT, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({
      schema_version: 2,
      sid,
      user_prompt: 'tier skill test',
      tier,
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
  fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# Test agent for tier-skill tests\n');

  // Skill that requires deep_research tier
  const deepDir = path.join(agentSkillsDir, 'deep-only');
  fs.mkdirSync(deepDir, { recursive: true });
  fs.writeFileSync(
    path.join(deepDir, 'SKILL.md'),
    '---\ntier: deep_research\n---\n# Deep Research Only Skill\n'
  );

  // Skill that requires fact tier
  const factDir = path.join(agentSkillsDir, 'fact-only');
  fs.mkdirSync(factDir, { recursive: true });
  fs.writeFileSync(
    path.join(factDir, 'SKILL.md'),
    '---\ntier: fact\n---\n# Fact Only Skill\n'
  );

  // Skill with no tier restriction
  const universalDir = path.join(agentSkillsDir, 'universal-skill');
  fs.mkdirSync(universalDir, { recursive: true });
  fs.writeFileSync(
    path.join(universalDir, 'SKILL.md'),
    '# Universal Skill — no tier restriction\n'
  );
});

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  for (const sid of createdSids) {
    try { fs.rmSync(path.join(RUNS_ROOT, sid), { recursive: true, force: true }); } catch (_) {}
  }
});

// RED: deep_research skill must NOT appear when session tier is fact.
// Fails today because provisionOne symlinks all skills unconditionally.
test('skill with tier:deep_research is NOT injected into a fact-tier session', () => {
  const sid = prepareSession('fact');
  const meta = provisionOne({ agent: agentName, task: 'test', goal: 'test', cwd: ADVISOR_ROOT }, sid);
  const skillLink = path.join(meta.workspace, '.claude', 'skills', 'deep-only');
  expect(fs.existsSync(skillLink)).toBe(false);
});

// GREEN (should pass even before filter is implemented — all skills are symlinked)
test('skill with tier:fact IS injected into a fact-tier session', () => {
  const sid = prepareSession('fact');
  const meta = provisionOne({ agent: agentName, task: 'test', goal: 'test', cwd: ADVISOR_ROOT }, sid);
  const skillLink = path.join(meta.workspace, '.claude', 'skills', 'fact-only');
  expect(fs.existsSync(skillLink)).toBe(true);
});

// GREEN (should pass even before filter is implemented)
test('skill with no tier field is always injected regardless of session tier', () => {
  const sid = prepareSession('fact');
  const meta = provisionOne({ agent: agentName, task: 'test', goal: 'test', cwd: ADVISOR_ROOT }, sid);
  const skillLink = path.join(meta.workspace, '.claude', 'skills', 'universal-skill');
  expect(fs.existsSync(skillLink)).toBe(true);
});
