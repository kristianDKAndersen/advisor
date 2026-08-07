import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpVaultRoot;
let logs;
let origError;

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fts5-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
  vault.writeNote(
    'notes/fts5-fallback-seed.md',
    { type: 'note', created_at: new Date().toISOString() },
    'This note discusses C++ and node.js and c# together in one place.'
  );
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
});

// Previously-failing inputs (raised an FTS5 parse/column error that was
// swallowed to [] with no rescue). Must now return without throwing.
const FAILING_INPUTS = [
  'C++', 'c#', 'node.js', '50%', '+', '*foo',
  'a(b', 'a)b', '()', 'a"b', 'AND', 'OR',
  'x AND', 'foo NOT', 'a:b:c', '"multi-agent" OR C++',
];

for (const input of FAILING_INPUTS) {
  test(`searchNotes does not throw or log for previously-failing input: ${JSON.stringify(input)}`, () => {
    origError = console.error;
    logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    let results;
    expect(() => { results = vault.searchNotes(input, 10); }).not.toThrow();
    console.error = origError;
    expect(Array.isArray(results)).toBe(true);
    expect(logs.some(l => l.includes('searchNotes failed'))).toBe(false);
  });
}

test('C++ retrieves the seeded note via searchNotes', () => {
  const results = vault.searchNotes('C++', 10);
  expect(results.some(r => r.path === 'notes/fts5-fallback-seed.md')).toBe(true);
});

test('node.js retrieves the seeded note via searchNotes', () => {
  const results = vault.searchNotes('node.js', 10);
  expect(results.some(r => r.path === 'notes/fts5-fallback-seed.md')).toBe(true);
});

test('c# retrieves the seeded note via searchNotes', () => {
  const results = vault.searchNotes('c#', 10);
  expect(results.some(r => r.path === 'notes/fts5-fallback-seed.md')).toBe(true);
});

test('legacy mode: C++ does not throw and retrieves the seeded note', () => {
  let results;
  expect(() => { results = vault.searchNotes('C++', 10, { legacy: true }); }).not.toThrow();
  expect(results.some(r => r.path === 'notes/fts5-fallback-seed.md')).toBe(true);
});

// Currently-working inputs — behaviour must be preserved exactly.
test('trailing-star prefix search still works: a*', () => {
  vault.writeNote('notes/prefix-star-seed.md', { type: 'note', created_at: new Date().toISOString() }, 'apricot alligator avalanche.');
  const results = vault.searchNotes('apri*', 10);
  expect(results.some(r => r.path === 'notes/prefix-star-seed.md')).toBe(true);
});

test('body: column filter still works', () => {
  const results = vault.searchNotes('body:C++', 10);
  expect(Array.isArray(results)).toBe(true);
});

test('boolean OR still works: x OR y', () => {
  vault.writeNote('notes/bool-or-seed.md', { type: 'note', created_at: new Date().toISOString() }, 'zqfoobar term present here.');
  const results = vault.searchNotes('zqfoobar OR zqbazqux', 10);
  expect(results.some(r => r.path === 'notes/bool-or-seed.md')).toBe(true);
});

test('quoted phrase still works', () => {
  vault.writeNote('notes/phrase-seed.md', { type: 'note', created_at: new Date().toISOString() }, 'the phrase zqalpha zqbeta appears here.');
  const results = vault.searchNotes('"zqalpha zqbeta"', 10);
  expect(results.some(r => r.path === 'notes/phrase-seed.md')).toBe(true);
});

test('hyphenated-token case still works (regression, scenario 8 style)', () => {
  vault.writeNote('notes/hyphen-seed.md', { type: 'note', created_at: new Date().toISOString() }, 'zqdeep-zqresearch task type noted here.');
  const results = vault.searchNotes('zqdeep-zqresearch', 10);
  expect(results.some(r => r.path === 'notes/hyphen-seed.md')).toBe(true);
});

test('non-ASCII input does not throw: emoji', () => {
  expect(() => vault.searchNotes('emoji 🎉', 10)).not.toThrow();
});

test('-- does not throw', () => {
  expect(() => vault.searchNotes('--', 10)).not.toThrow();
});

test('NEAR alone does not throw', () => {
  expect(() => vault.searchNotes('NEAR', 10)).not.toThrow();
});

test('empty quoted string does not throw', () => {
  expect(() => vault.searchNotes('""', 10)).not.toThrow();
});

// searchEpisodeGoals audit: tokens are pre-stripped to alphanumeric only and
// the call site already fail-opens via its own try/catch, so the same
// FTS5-parse-error class cannot surface as a thrown exception here either.
for (const input of FAILING_INPUTS) {
  test(`searchEpisodeGoals does not throw for previously-failing input: ${JSON.stringify(input)}`, () => {
    expect(() => vault.searchEpisodeGoals(input, 10)).not.toThrow();
  });
}

test('searchEpisodeGoals still finds a goal by plain token', () => {
  vault.indexEpisodeGoal('fts5-fallback-test-sid', 'investigate zqgoalterm behaviour');
  const results = vault.searchEpisodeGoals('zqgoalterm', 10);
  expect(results.includes('fts5-fallback-test-sid')).toBe(true);
});
