import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

const vault = require('../lib/vault');
const { heuristicSection, recallForTask } = require('../lib/vault-recall');
const lessons = require('../lib/lessons');

let vaultRoot;
let runsRoot;

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heur-heading-vault-'));
  runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heur-heading-runs-'));
  process.env.ADVISOR_VAULT = vaultRoot;
  process.env.ADVISOR_RUNS_ROOT = runsRoot;
});

afterEach(() => {
  delete process.env.ADVISOR_RUNS_ROOT;
  fs.rmSync(vaultRoot, { recursive: true, force: true });
  fs.rmSync(runsRoot, { recursive: true, force: true });
});

const section = (heading, text = 'Check the branch first.') =>
  `# Title\nintro\n\n${heading}\n${text}\n\n## Evidence\nother\n`;

test('heuristicSection matches plain heading', () => {
  expect(heuristicSection(section('## Heuristic'))).toBe('Check the branch first.');
});

test('heuristicSection matches parenthesised suffix', () => {
  expect(heuristicSection(section('## Heuristic (one-line)'))).toBe('Check the branch first.');
});

test('heuristicSection matches slash suffix', () => {
  expect(heuristicSection(section('## Heuristic / state as of 2026-06-16'))).toBe('Check the branch first.');
});

test('heuristicSection matches plural Heuristics', () => {
  expect(heuristicSection(section('## Heuristics (reusable for future sessions)'))).toBe('Check the branch first.');
});

test('heuristicSection ignores HeuristicsTable-style heading', () => {
  expect(heuristicSection(section('## HeuristicsTable'))).toBe('');
  expect(heuristicSection(section('## Heuristicx'))).toBe('');
});

test('heuristicSection joins multiple sections', () => {
  const body = '## Heuristic\nfirst\n\n## Notes\nskip\n\n## Heuristics (more)\nsecond\n';
  expect(heuristicSection(body)).toBe('first\n\nsecond');
});

test('approve accepts lesson with variant heading', () => {
  const rel = 'lessons/variant.md';
  vault.writeNote(rel, { type: 'lesson', status: 'proposed', audience: 'both', created_at: new Date().toISOString() },
    '## Heuristic (one-line)\nAlways check the branch first.\n');
  lessons.approveLesson('variant.md');
  expect(vault.readNote(rel).fm.status).toBe('active');
});

test('recall uses variant heading text not body fallback', () => {
  vault.writeNote('lessons/variant-recall.md', {
    type: 'lesson', sid: 'S-v', agent: 'coder', created_at: new Date().toISOString(),
    task_type: 'coder', tags: 'payment gateway migration',
  }, 'PREAMBLE payment gateway migration context\n\n## Heuristics (reusable for future sessions)\nStage the rollout behind a flag.\n\n## Evidence\nmore\n');
  const r = recallForTask('Plan the payment gateway migration rollout for the billing service.', { lessonLimit: 5 });
  expect(r.lessons.length).toBe(1);
  expect(r.lessons[0].heuristic).toBe('Stage the rollout behind a flag.');
});
