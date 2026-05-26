import { test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const COMPACTOR = join(REPO, 'lib/compactor.js');

function runCompactor(stdinPayload) {
  return spawnSync('node', [COMPACTOR], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('entry-point: exits 0 with empty transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compactor-'));
  const transcriptPath = join(dir, 'empty.jsonl');
  writeFileSync(transcriptPath, '');

  const result = runCompactor({ transcript_path: transcriptPath });
  expect(result.status).toBe(0);
});

test('entry-point: writes compacted messages back to transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compactor-'));
  const transcriptPath = join(dir, 'empty.jsonl');
  writeFileSync(transcriptPath, '');

  const result = runCompactor({ transcript_path: transcriptPath });
  expect(result.status).toBe(0);

  const written = readFileSync(transcriptPath, 'utf8').trim();
  const messages = written.split('\n').filter(Boolean).map(l => JSON.parse(l));
  // Empty transcript compacts to the guarantee-non-empty fallback
  expect(messages.length).toBeGreaterThan(0);
  expect(messages[0].role).toBe('user');
});

test('entry-point: exits 0 when transcript has real messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compactor-'));
  const transcriptPath = join(dir, 'real.jsonl');
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ];
  writeFileSync(transcriptPath, msgs.map(m => JSON.stringify(m)).join('\n'));

  const result = runCompactor({ transcript_path: transcriptPath });
  expect(result.status).toBe(0);

  const written = readFileSync(transcriptPath, 'utf8').trim();
  const messages = written.split('\n').filter(Boolean).map(l => JSON.parse(l));
  expect(messages.length).toBeGreaterThan(0);
});

test('entry-point: exits 0 with malformed stdin (graceful)', () => {
  const result = spawnSync('node', [COMPACTOR], {
    input: 'not json',
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(0);
});

test('entry-point: exits 0 when transcript_path missing from payload', () => {
  const result = runCompactor({});
  expect(result.status).toBe(0);
});
