// Regression coverage for lib/channel.js parseEnvelope(): every worker-sent
// result today stores `body` as a JSON-encoded STRING (channel.js send --body
// takes a raw CLI string, see cli()'s send handler), not an object. Readers
// that only checked `typeof body === 'object'` silently no-op for real
// workers. These tests seed string bodies, matching production shape.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import os from 'os';
import fs from 'fs';
import path from 'path';

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;

let tmpVault;
let tmpRuns;

beforeAll(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-envstr-'));
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-envstr-'));
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

function runSynthesize(args, sid) {
  return spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize', '--sid', sid, '--seq', '99',
     '--established', 'test', '--gap', 'none', '--material', 'yes',
     '--next', 'proceed-to-step-8',
     ...args],
    {
      encoding: 'utf8',
      timeout: 25000,
      env: {
        ...process.env,
        ADVISOR_VAULT: tmpVault,
        ADVISOR_RUNS_ROOT: tmpRuns,
        ADVISOR_SKIP_TAB_CLOSE: '1',
      },
    }
  );
}

// Seed a result whose body is a JSON-encoded STRING, exactly what
// `channel.js send --body '<json>'` produces on disk.
function seedStringBodyResults(sid, verdicts) {
  const dir = path.join(tmpRuns, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  const lines = verdicts.map((verdict, i) => JSON.stringify({
    seq: i + 1, type: 'result', from: 'coder', ts: Date.now() / 1000,
    body: JSON.stringify({ verdict, summary: 'test', paths: [] }),
  }));
  fs.writeFileSync(path.join(dir, 'outbox.jsonl'), lines.join('\n') + '\n');
}

test('synthesize emits LESSON EXTRACTION on 2nd blocked STRING-body verdict', () => {
  const sid = `envstr-2blk-${Date.now()}`;
  seedStringBodyResults(sid, ['blocked', 'blocked']);
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('LESSON EXTRACTION REQUIRED');
  expect(result.stdout).toContain('/extract-lesson');
  expect(result.stdout).toContain(sid);
}, TEST_TIMEOUT);

test('recv prints Result envelope block (SUMMARY/VERDICT/PATHS) for a STRING body', () => {
  const sid = `envstr-recv-${Date.now()}`;
  const dir = path.join(tmpRuns, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  const outboxPath = path.join(dir, 'outbox.jsonl');
  const msg = {
    seq: 1, type: 'result', from: 'coder', ts: Date.now() / 1000,
    body: JSON.stringify({ verdict: 'complete', summary: 'string-body summary', paths: ['/tmp/x.md'] }),
  };
  fs.writeFileSync(outboxPath, JSON.stringify(msg) + '\n');

  const result = spawnSync('bun', [CHANNEL_JS, 'recv', '--file', outboxPath], {
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Result envelope received:');
  expect(result.stdout).toContain('SUMMARY: string-body summary');
  expect(result.stdout).toContain('VERDICT: complete');
  expect(result.stdout).toContain('/tmp/x.md');
}, TEST_TIMEOUT);

test('synthesize calls setWorkerVerdict for a STRING-body result', () => {
  const sid = `envstr-setverdict-${Date.now()}`;
  seedStringBodyResults(sid, ['complete']);
  const result = runSynthesize([], sid);
  expect(result.status).toBe(0);

  const db = new Database(path.join(tmpVault, '.cache', 'vault.db'));
  const row = db.prepare(`SELECT worker_verdict FROM notes WHERE path = ?`).get(`synthesis/${sid}-99.md`);
  db.close();
  expect(row).not.toBeNull();
  expect(row.worker_verdict).toBe('complete');
}, TEST_TIMEOUT);

// N4: a JSON-object body with neither summary nor verdict is not an envelope —
// the block must not render (previously printed "SUMMARY: undefined").
test('recv omits the Result envelope block for a non-envelope JSON-object body', () => {
  const sid = `envstr-noenv-${Date.now()}`;
  const dir = path.join(tmpRuns, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  const outboxPath = path.join(dir, 'outbox.jsonl');
  const msg = {
    seq: 1, type: 'result', from: 'coder', ts: Date.now() / 1000,
    body: JSON.stringify({ foo: 'bar', baz: 1 }),
  };
  fs.writeFileSync(outboxPath, JSON.stringify(msg) + '\n');

  const result = spawnSync('bun', [CHANNEL_JS, 'recv', '--file', outboxPath], {
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('Result envelope received:');
  expect(result.stdout).not.toContain('undefined');
}, TEST_TIMEOUT);
