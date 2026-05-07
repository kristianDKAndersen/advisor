import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let episodes;
let tmpHome;
let episodesPath;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'episodes-test-'));
  process.env.HOME = tmpHome;
  episodesPath = path.join(tmpHome, '.advisor', 'memory', 'episodes.jsonl');
  episodes = await import('../lib/episodes.js');
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('writeEpisode is a named export', () => {
  expect(typeof episodes.writeEpisode).toBe('function');
});

test('queryEpisodes is a named export', () => {
  expect(typeof episodes.queryEpisodes).toBe('function');
});

test('writeEpisode appends a JSONL line with all 6 keys', () => {
  const record = {
    sid: 'test-sid-1',
    task_hash: 'hash-a',
    ts: 1700000000,
    established: 'Pattern X works well.',
    gap: 'Coverage on edge cases.',
    key_quotes: 'Quote 1'
  };
  episodes.writeEpisode(record);
  expect(fs.existsSync(episodesPath)).toBe(true);
  const lines = fs.readFileSync(episodesPath, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.sid).toBe('test-sid-1');
  expect(entry.task_hash).toBe('hash-a');
  expect(entry.ts).toBe(1700000000);
  expect(entry.established).toBe('Pattern X works well.');
  expect(entry.gap).toBe('Coverage on edge cases.');
  expect(entry.key_quotes).toBe('Quote 1');
});

test('queryEpisodes returns records matching task_hash, capped at limit', () => {
  fs.rmSync(episodesPath, { force: true });
  episodes.writeEpisode({ sid: 's1', task_hash: 'hash-a', ts: 1, established: 'e1', gap: 'g1', key_quotes: 'q1' });
  episodes.writeEpisode({ sid: 's2', task_hash: 'hash-a', ts: 2, established: 'e2', gap: 'g2', key_quotes: 'q2' });
  episodes.writeEpisode({ sid: 's3', task_hash: 'hash-b', ts: 3, established: 'e3', gap: 'g3', key_quotes: 'q3' });

  const a10 = episodes.queryEpisodes('hash-a', 10);
  expect(a10.length).toBe(2);

  const b10 = episodes.queryEpisodes('hash-b', 10);
  expect(b10.length).toBe(1);

  const a1 = episodes.queryEpisodes('hash-a', 1);
  expect(a1.length).toBe(1);
});

test('queryEpisodes with empty file returns []', () => {
  fs.mkdirSync(path.dirname(episodesPath), { recursive: true });
  fs.writeFileSync(episodesPath, '');
  const result = episodes.queryEpisodes('any-hash', 10);
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(0);
});
