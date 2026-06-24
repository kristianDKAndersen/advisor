// tests/episodes-fuzzy.test.js — fuzzy episodic memory matching
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

let episodes;
let vault;
let tmpHome;
let tmpVault;

function hashGoal(goal) {
  return createHash('sha256').update(goal.slice(0, 200)).digest('hex');
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-fuzzy-'));
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-fuzzy-vault-'));
  process.env.HOME = tmpHome;
  process.env.ADVISOR_VAULT = tmpVault;

  vault = await import('../lib/vault.js');
  episodes = await import('../lib/episodes.js');
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

test('queryEpisodesFuzzy is a named export', () => {
  expect(typeof episodes.queryEpisodesFuzzy).toBe('function');
});

test('searchEpisodeGoals is exported from vault.js', () => {
  expect(typeof vault.searchEpisodeGoals).toBe('function');
});

test('indexEpisodeGoal is exported from vault.js', () => {
  expect(typeof vault.indexEpisodeGoal).toBe('function');
});

test('exact-hash misses sibling, queryEpisodesFuzzy finds it', () => {
  const goalA = 'Research X for project Y';
  const goalB = 'Research X for project Z';
  const hashA = hashGoal(goalA);
  const hashB = hashGoal(goalB);

  // hashA and hashB must be different (goals differ)
  expect(hashA).not.toBe(hashB);

  // Seed episode A
  episodes.writeEpisode({
    sid: 'fuzzy-sid-a',
    task_hash: hashA,
    goal: goalA,
    ts: 1700000001,
    established: 'Project Y completed.',
    gap: 'none',
    key_quotes: '',
  });

  // Seed episode B (sibling — near-identical goal, different project)
  episodes.writeEpisode({
    sid: 'fuzzy-sid-b',
    task_hash: hashB,
    goal: goalB,
    ts: 1700000002,
    established: 'Project Z completed.',
    gap: 'none',
    key_quotes: '',
  });

  // Exact-hash queryEpisodes with hashA returns A but NOT B
  const exactResults = episodes.queryEpisodes(hashA, 10);
  const exactSids = exactResults.map(e => e.sid);
  expect(exactSids).toContain('fuzzy-sid-a');
  expect(exactSids).not.toContain('fuzzy-sid-b');

  // Fuzzy query for goalA should return B (the sibling)
  const fuzzyResults = episodes.queryEpisodesFuzzy(goalA, 10);
  const fuzzySids = fuzzyResults.map(e => e.sid);
  expect(fuzzySids).toContain('fuzzy-sid-b');
});
