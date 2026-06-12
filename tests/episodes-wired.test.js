import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');

let tmpHome;
let tmpRuns;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-wired-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-wired-runs-'));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

test('channel synthesize: writeEpisode called when result body has established field', () => {
  const sid = `ep-wired-${Date.now()}`;

  const result = spawnSync('bun', [
    CHANNEL_JS, 'synthesize',
    '--sid', sid,
    '--seq', '1',
    '--established', 'Pattern X worked well for this task.',
    '--gap', 'none',
    '--material', 'yes',
    '--next', 'proceed-to-step-8',
    '--key-quotes', 'The key insight was Y.',
  ], {
    encoding: 'utf8',
    timeout: 25000,
    env: {
      ...process.env,
      HOME: tmpHome,
      ADVISOR_RUNS_ROOT: tmpRuns,
      ADVISOR_SKIP_TAB_CLOSE: '1',
    },
  });

  expect(result.status).toBe(0);

  const episodesFile = path.join(tmpHome, '.advisor', 'memory', 'episodes.jsonl');
  expect(fs.existsSync(episodesFile)).toBe(true);

  const lines = fs.readFileSync(episodesFile, 'utf8').trim().split('\n').filter(Boolean);
  const episode = JSON.parse(lines[lines.length - 1]);
  expect(episode.sid).toBe(sid);
  expect(episode.established).toBe('Pattern X worked well for this task.');
  expect(typeof episode.ts).toBe('number');
}, 30000);

test('queryEpisodes result injected into inbox task body when episodes exist', async () => {
  const goal = 'Implement the test suite for advisor core-lib.';
  const taskHash = createHash('sha256').update(goal.slice(0, 200)).digest('hex');

  // Pre-seed the episodes file
  const epDir = path.join(tmpHome, '.advisor', 'memory');
  fs.mkdirSync(epDir, { recursive: true });
  const epFile = path.join(epDir, 'episodes.jsonl');
  fs.appendFileSync(epFile, JSON.stringify({
    sid: 'seed-sid',
    task_hash: taskHash,
    ts: 1700000000,
    established: 'Red-green cycle worked smoothly.',
    gap: 'no gaps',
    key_quotes: 'The TDD approach succeeded.',
  }) + '\n');

  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const { composeTaskBody } = await import('../lib/summon.js');
    const body = composeTaskBody({
      sid: `ep-inject-${Date.now()}`,
      task: 'implement the thing',
      goal,
      discoveryHint: false,
    });

    expect(body).toContain('## Past episodes');
    expect(body).toContain('Red-green cycle worked smoothly.');
  } finally {
    process.env.HOME = origHome;
  }
}, 30000);
