import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Regression suite for the retrieval-fidelity fixes (D1 frontmatter indexing,
// D2 disjunctive multi-keyword search, D3 opt-in relevance floor).
//
// Uses the fresh temp-vault fixture pattern from tests/vault.test.js — it does
// NOT touch the live vault. Goals (2)/(3) reproduce the exact real lesson path
// in-fixture so the assertions are deterministic and durable. The pre-fix
// behaviour these guard against (searchNotes returns []) is captured verbatim
// as the RED evidence in the accompanying changes.md.

let vault;
let tmpVaultRoot;
let prevVault;

const LESSON_PATH = 'lessons/manual-20260527-coder-fabricated-test-results-advisor-1.md';
// Real frontmatter routing tokens from the lesson. task_type + tags carry
// 'pasted-evidence', 'verification', 'coder' — none of which appear in the body
// below, so pre-fix (body-only FTS) they are invisible to search.
const LESSON_FM = {
  type: 'lesson',
  created_at: new Date().toISOString(),
  task_type: 'code coder tests verification tdd implement fix',
  tags: 'coder fabrication test-output verification trust honesty pasted-evidence',
  agent: 'coder',
};
// Body deliberately EXCLUDES the tokens 'evidence', 'verification' and 'pasted'
// so that pre-fix searchNotes('pasted-evidence') and the 4-token AND query both
// return []. It does contain 'coder'/'test'/'code' to make the D2 OR case real.
const LESSON_BODY =
  'A worker reported passing tests during a code review. The coder claimed all ' +
  'tests pass, but an independent re-run of the test suite showed failures.';

beforeAll(async () => {
  prevVault = process.env.ADVISOR_VAULT;
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fidelity-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
  vault.writeNote(LESSON_PATH, LESSON_FM, LESSON_BODY);
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
  // Restore rather than delete, so the next test file in this process does not
  // inherit an unset ADVISOR_VAULT (which would resolve to the live vault).
  if (prevVault === undefined) delete process.env.ADVISOR_VAULT;
  else process.env.ADVISOR_VAULT = prevVault;
});

// D1 — goal (2): a query composed only of a frontmatter routing token retrieves
// the note. Pre-fix this returned [] because notes_fts indexed only body.
test('D1: searchNotes("pasted-evidence") returns the fabricated-results lesson', () => {
  const results = vault.searchNotes('pasted-evidence', 10);
  expect(results.find(r => r.path === LESSON_PATH)).toBeDefined();
});

// D2 — goal (3): multi-keyword search is disjunctive (OR), not conjunctive (AND).
// Pre-fix the space-joined query was implicit AND, so more keywords => fewer hits
// and this returned [] (body lacks 'evidence'/'verification').
test('D2: "coder test evidence verification" is OR and returns the lesson', () => {
  const results = vault.searchNotes('coder test evidence verification', 10);
  expect(results.find(r => r.path === LESSON_PATH)).toBeDefined();
});

// D2 — backwards compatibility: a query that already uses FTS operators/phrases
// must be passed through verbatim (not re-ORed into a syntax error).
test('D2: explicit boolean/quoted queries are not corrupted', () => {
  expect(Array.isArray(vault.searchNotes('"multi-agent" OR C++', 5))).toBe(true);
});

// D3 — goal (4): the floor is opt-in; the SAME query returns >0 with it off and
// 0 with it on. relevance is strictly < 1, so minRelevance:1.0 gates everything.
test('D3: relevance floor suppresses hits that pass with the floor off', () => {
  const off = vault.searchNotes('code', 10);
  expect(off.length).toBeGreaterThan(0);
  const on = vault.searchNotes('code', 10, { minRelevance: 1.0 });
  expect(on.length).toBe(0);
});

// D3 — goal (5): the floor gates on the RELEVANCE component, not the blended
// score, so recency cannot rescue an irrelevant note. A common (low-IDF) token
// keeps absolute relevance low; a freshly-created note gets a high BLEND from
// recency yet is still suppressed.
test('D3: a fresh, weakly-matching note is gated out despite high recency', () => {
  for (let i = 0; i < 15; i++) {
    vault.writeNote(`synthesis/filler-${i}.md`,
      { type: 'synthesis', created_at: '2024-01-01T00:00:00.000Z' },
      `commontoken filler note number ${i} about assorted unrelated matters`);
  }
  vault.writeNote('synthesis/fresh-weak.md',
    { type: 'synthesis', created_at: new Date().toISOString() },
    'commontoken fresh recent note');

  const off = vault.searchNotes('commontoken', 20);
  const fresh = off.find(r => r.path === 'synthesis/fresh-weak.md');
  expect(fresh).toBeDefined();
  // Recency + confidence inflate the BLEND well past the threshold we use below.
  expect(fresh.score).toBeGreaterThanOrEqual(0.45);

  const on = vault.searchNotes('commontoken', 20, { minRelevance: 0.45 });
  expect(on.find(r => r.path === 'synthesis/fresh-weak.md')).toBeUndefined();
});

// D3 — invariants (5): default-off (no opts) suppresses nothing, and the legacy
// shape is unchanged (no score field).
test('D3: floor is default-off and legacy shape is preserved', () => {
  const def = vault.searchNotes('commontoken', 20);
  expect(def.length).toBeGreaterThan(0);
  const legacy = vault.searchNotes('commontoken', 5, { legacy: true });
  expect(legacy.length).toBeGreaterThan(0);
  expect(legacy[0].score).toBeUndefined();
});
