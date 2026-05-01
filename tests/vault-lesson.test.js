import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpVaultRoot;

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-lesson-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
  delete process.env.ADVISOR_VAULT;
});

// Scenario 5: empty vault returns [] — must run before any notes are written
test('scenario 5: empty vault — searchNotes returns [] and does not throw', () => {
  const results = vault.searchNotes('deep-research literature-survey', 5);
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBe(0);
});

// Scenario 6: FTS5 special characters are caught by existing try/catch
test('scenario 6: FTS5 special chars in query — searchNotes does not throw', () => {
  const results = vault.searchNotes('"multi-agent" OR C++', 5);
  expect(Array.isArray(results)).toBe(true);
});

// Scenario 1: writeLesson creates file with correct path and frontmatter
test('scenario 1: writeLesson creates lessons/<sid>-<agent>-<seq>.md with type:lesson and polarity:negative', () => {
  const record = {
    sid: 'test-sid',
    agent: 'researcher',
    synthesis_seq: 1,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    task_type: 'deep-research literature-survey',
    failure_mode: 'low_citation_precision',
    evaluator_dim: 'citation_precision',
    root_cause: 'The researcher queried arXiv broadly without verifying publication status.',
    heuristic: 'When task_type includes literature-survey, do NOT cite preprints without verification because unverified citations reduce precision. Instead, verify each paper status.',
    score: 'citation_precision=0.41'
  };
  vault.writeLesson(record);

  const notePath = path.join(tmpVaultRoot, 'lessons', 'test-sid-researcher-1.md');
  expect(fs.existsSync(notePath)).toBe(true);

  const content = fs.readFileSync(notePath, 'utf8');
  const { fm } = vault.parseFrontmatter(content);
  expect(fm.type).toBe('lesson');
  expect(fm.polarity).toBe('negative');
  expect(fm.sid).toBe('test-sid');
  expect(fm.agent).toBe('researcher');
  expect(fm.evaluator_dim).toBe('citation_precision');
});

// Scenario 1b: written lesson is findable via FTS5 search.
// FTS5 tokenizes "deep-research" into {deep, research} in content, and in a
// query "-research" means NOT-research. Use token words without hyphens to
// avoid the implicit NOT interpretation.
test('scenario 1b: searchNotes returns written lesson by task_type keywords', () => {
  const results = vault.searchNotes('literature survey', 5);
  expect(results.length).toBeGreaterThan(0);
  const match = results.find(r => r.type === 'lesson');
  expect(match).toBeDefined();
});

// Scenario 1c: audit line appended to .cache/lessons.jsonl
test('scenario 1c: writeLesson appends audit line to .cache/lessons.jsonl', () => {
  const auditPath = path.join(tmpVaultRoot, '.cache', 'lessons.jsonl');
  expect(fs.existsSync(auditPath)).toBe(true);
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  const entries = lines.map(l => JSON.parse(l));
  const match = entries.find(e => e.agent === 'researcher' && e.task_type === 'deep-research literature-survey');
  expect(match).toBeDefined();
  expect(match.sid).toBe('test-sid');
  expect(match.path).toBe('lessons/test-sid-researcher-1.md');
});

// Scenario 8: hyphenated task_type tags are searchable via searchNotes
// Regression test for FTS5 hyphen-as-NOT-operator bug.
// Prior to the fix, searchNotes('deep-research', 5) returned [] because FTS5
// parsed "deep-research" as "deep AND NOT research".
test('scenario 8: hyphenated task_type tags are searchable via searchNotes', () => {
  // lesson with task_type 'deep-research literature-survey' was written in scenario 1
  const byHyphen = vault.searchNotes('deep-research', 5);
  expect(byHyphen.length).toBeGreaterThan(0);
  const match = byHyphen.find(r => r.path.startsWith('lessons/'));
  expect(match).toBeDefined();

  const byFullTag = vault.searchNotes('deep-research literature-survey', 5);
  expect(byFullTag.length).toBeGreaterThan(0);
});

// Scenario 7: missing evaluator_dim defaults to 'verdict:blocked'
test('scenario 7: missing evaluator_dim defaults to verdict:blocked in frontmatter', () => {
  const record = {
    sid: 's',
    agent: 'planner',
    synthesis_seq: 2,
    task_type: 'plan-decomposition',
    failure_mode: 'blocked',
    root_cause: 'The planner did not decompose the task into verifiable subtasks.',
    heuristic: 'When task_type includes plan-decomposition, do NOT skip subtask verification because unverified tasks slip scope. Instead, assert each subtask has a machine-verifiable DoD.',
    score: 'n/a'
  };
  vault.writeLesson(record);

  const notePath = path.join(tmpVaultRoot, 'lessons', 's-planner-2.md');
  expect(fs.existsSync(notePath)).toBe(true);

  const content = fs.readFileSync(notePath, 'utf8');
  const { fm } = vault.parseFrontmatter(content);
  expect(fm.evaluator_dim).toBe('verdict:blocked');
  expect(fm.type).toBe('lesson');
});
