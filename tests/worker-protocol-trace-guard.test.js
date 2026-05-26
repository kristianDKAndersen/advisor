import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const SKILL_MD = path.resolve(import.meta.dir, '../skills/worker-protocol/SKILL.md');

// PROMPT-1: skills/worker-protocol/SKILL.md must guard manual trace writes behind
// ADVISOR_WORKER_HOOKS != 1 to prevent duplicate entries when the PostToolUse hook
// (lib/hooks/worker-trace.js) is active.

test('SKILL.md mentions ADVISOR_WORKER_HOOKS in the tracing section', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  expect(content).toContain('ADVISOR_WORKER_HOOKS');
});

test('SKILL.md tracing section contains a guard against duplicate writes when ADVISOR_WORKER_HOOKS=1', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  // Must describe skipping manual write when the env var is 1
  expect(content).toMatch(/ADVISOR_WORKER_HOOKS.*=.*1.*skip|skip.*manual.*ADVISOR_WORKER_HOOKS|When.*ADVISOR_WORKER_HOOKS=1.*skip/is);
});

test('SKILL.md tracing section retains the manual-write path for ADVISOR_WORKER_HOOKS unset or 0', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  // Must still describe the manual write command for agents without the hook
  expect(content).toContain('trace.jsonl');
  expect(content).toMatch(/unset|0/i);
});

test('SKILL.md tracing section references both branches: hook path and manual path', () => {
  const content = fs.readFileSync(SKILL_MD, 'utf8');
  // Hook branch: references the hook file
  expect(content).toMatch(/worker-trace\.js|PostToolUse hook/i);
  // Manual branch: still has the echo command example
  expect(content).toContain('echo');
  expect(content).toContain('trace.jsonl');
});
