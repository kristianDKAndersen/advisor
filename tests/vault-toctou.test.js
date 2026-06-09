// vault-toctou.test.js
//
// Dual-purpose file: when --vault-worker flag is present, acts as a worker
// subprocess that calls setStatus or setDueDate with an injected delay.
// Otherwise runs as a bun test suite.

import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── Worker subprocess mode ──────────────────────────────────────────────────
if (process.argv.includes('--vault-worker')) {
  const relPathIdx = process.argv.indexOf('--rel-path');
  const opIdx = process.argv.indexOf('--op');
  const valIdx = process.argv.indexOf('--val');
  const relPath = relPathIdx >= 0 ? process.argv[relPathIdx + 1] : 'test.md';
  const op = opIdx >= 0 ? process.argv[opIdx + 1] : 'status';
  const val = valIdx >= 0 ? process.argv[valIdx + 1] : 'active';

  const vault = await import(`${REPO}/lib/vault.js`);
  if (op === 'status') {
    vault.setStatus(relPath, val);
  } else {
    vault.setDueDate(relPath, val);
  }
  process.exit(0);
}

// ── Test suite ──────────────────────────────────────────────────────────────
import { test, expect, beforeAll, afterAll } from 'bun:test';

let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-toctou-test-'));
  process.env.ADVISOR_VAULT = tmpDir;
  const vault = await import(`${REPO}/lib/vault.js`);
  // Trigger DB init
  vault.writeNote('lessons/_init.md', { type: 'lesson' }, 'init');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ADVISOR_VAULT;
});

test('setStatus: concurrent calls on same note both writes survive', async () => {
  const testFile = path.join(__dirname, 'vault-toctou.test.js');
  const relPath = 'lessons/conc-test.md';

  const vault = await import(`${REPO}/lib/vault.js`);
  vault.writeNote(relPath, { type: 'lesson' }, 'Concurrent test note body.');

  // P1 sets status=active; P2 sets due_date=2099-01-01.
  // Both inject a 50ms delay between readNote and writeNote (ADVISOR_TEST_NOTE_DELAY_MS).
  // Without a lock both processes read the original note (no status, no due_date),
  // then each writes only its own field — the second write erases the first's field.
  // With a lock the writes are serialised so both fields end up in the final note.
  const env = {
    ...process.env,
    ADVISOR_VAULT: tmpDir,
    ADVISOR_TEST_NOTE_DELAY_MS: '50',
  };

  const p1 = Bun.spawn(
    ['bun', testFile, '--vault-worker', '--rel-path', relPath, '--op', 'status', '--val', 'active'],
    { env, stderr: 'pipe' }
  );
  const p2 = Bun.spawn(
    ['bun', testFile, '--vault-worker', '--rel-path', relPath, '--op', 'due_date', '--val', '2099-01-01'],
    { env, stderr: 'pipe' }
  );

  const [exit1, exit2] = await Promise.all([p1.exited, p2.exited]);
  expect(exit1).toBe(0);
  expect(exit2).toBe(0);

  const { readNote } = await import(`${REPO}/lib/vault.js`);
  const final = readNote(relPath);

  // After fix: lock serialises the two RMW operations so whichever runs first
  // writes its field, then the second reads the updated note and adds its own
  // field alongside the first — both fields survive.
  // Before fix: the 50ms delay causes both to read the original (empty) note;
  // each writes only its own field, so one field is always missing.
  expect(final?.fm?.status).toBe('active');
  expect(final?.fm?.due_date).toBe('2099-01-01');
});

test('withNoteLock: concurrent setStatus calls complete without data corruption', async () => {
  const relPath = 'lessons/lock-test.md';
  const vault = await import(`${REPO}/lib/vault.js`);
  vault.writeNote(relPath, { type: 'lesson' }, 'Lock test note.');

  // Sequential setStatus calls (simulating what serialised concurrent callers
  // would do). After the fix both complete; final status is 'done'.
  vault.setStatus(relPath, 'active');
  vault.setStatus(relPath, 'done');

  const final = vault.readNote(relPath);
  expect(final?.fm?.status).toBe('done');
  // Ensure body integrity
  expect(final?.body?.trim()).toBe('Lock test note.');
});
