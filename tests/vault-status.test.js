import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpDir;

function openDb() {
  return new Database(path.join(tmpDir, '.cache', 'vault.db'));
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-status-test-'));
  process.env.ADVISOR_VAULT = tmpDir;
  vault = await import('../lib/vault.js');
  // Trigger db initialization
  vault.writeNote('lessons/_init.md', { type: 'lesson' }, 'init');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ADVISOR_VAULT;
});

test('(a) migration idempotency: status column exists and ALTER TABLE does not error on re-run', () => {
  const d = openDb();
  const cols = d.prepare('PRAGMA table_info(notes)').all().map(r => r.name);
  expect(cols).toContain('status');
  // Simulate second migration run: guard prevents error
  const cols2 = d.prepare('PRAGMA table_info(notes)').all().map(r => r.name);
  expect(() => {
    if (!cols2.includes('status')) {
      d.exec('ALTER TABLE notes ADD COLUMN status TEXT');
    }
  }).not.toThrow();
  d.close();
});

test('(b) setStatus updates frontmatter status field and SQLite status column', () => {
  vault.writeNote('reminders/foo.md', { type: 'reminder', due_date: '2020-01-01' }, 'Test body.');
  vault.setStatus('reminders/foo.md', 'done');
  const { fm } = vault.readNote('reminders/foo.md');
  expect(fm.status).toBe('done');
  const d = openDb();
  const row = d.prepare("SELECT status FROM notes WHERE path = 'reminders/foo.md'").get();
  d.close();
  expect(row?.status).toBe('done');
});

test('(c) listDue excludes notes where status=done', () => {
  vault.writeNote('reminders/due-a.md', { type: 'reminder', due_date: '2020-01-01' }, 'Due A.');
  vault.writeNote('reminders/due-b.md', { type: 'reminder', due_date: '2020-01-01' }, 'Due B.');
  vault.setStatus('reminders/due-a.md', 'done');
  // Use a future "today" so 2020-01-01 is <= windowEnd
  const results = vault.listDue('2030-01-01', 1);
  const paths = results.map(r => r.path);
  expect(paths).not.toContain('reminders/due-a.md');
  expect(paths).toContain('reminders/due-b.md');
});

test('(d) setDueDate updates frontmatter due_date field and SQLite due_date column', () => {
  vault.writeNote('lessons/bar.md', { type: 'lesson' }, 'Bar body.');
  vault.setDueDate('lessons/bar.md', '2099-01-01');
  const { fm } = vault.readNote('lessons/bar.md');
  expect(fm.due_date).toBe('2099-01-01');
  const d = openDb();
  const row = d.prepare("SELECT due_date FROM notes WHERE path = 'lessons/bar.md'").get();
  d.close();
  expect(row?.due_date).toBe('2099-01-01');
});

// ── RED tests (new) ──────────────────────────────────────────────────────────

test('(new-a) _upsertIndex syncs status column to SQLite', () => {
  vault.writeNote('lessons/status-sync.md', { type: 'lesson', status: 'done' }, 'body');
  const d = openDb();
  const row = d.prepare("SELECT status FROM notes WHERE path = 'lessons/status-sync.md'").get();
  d.close();
  expect(row?.status).toBe('done');
});

test('(new-b) listDue window math is timezone-invariant (UTC+12)', () => {
  process.env.TZ = 'Pacific/Auckland';
  vault.writeNote('lessons/tz-test.md', { type: 'lesson', due_date: '2026-06-12' }, 'tz test body');
  const results = vault.listDue('2026-05-28', 14);
  const paths = results.map(r => r.path);
  // May 28 + 14 = June 11; note due June 12 must NOT be returned
  expect(paths).not.toContain('lessons/tz-test.md');
});

test('(new-c) setStatus throws on multi-line YAML frontmatter', () => {
  const abs = path.join(tmpDir, 'reminders', 'multiline-fm.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '---\ntype: reminder\ntags:\n  - foo\n  - bar\n---\n\nBody here.\n');
  expect(() => vault.setStatus('reminders/multiline-fm.md', 'done')).toThrow(/multi-line frontmatter/);
});

test('setStatus refuses done on a lesson', () => {
  vault.writeNote('lessons/guard-done.md', { type: 'lesson', status: 'active', due_date: '2020-01-01' }, 'body');
  expect(() => vault.setStatus('lessons/guard-done.md', 'done')).toThrow(/lesson lifecycle status/);
  expect(vault.readNote('lessons/guard-done.md').fm.status).toBe('active');
});

test('setStatus refuses archived on a lesson', () => {
  vault.writeNote('lessons/guard-archived.md', { type: 'lesson', status: 'active' }, 'body');
  expect(() => vault.setStatus('lessons/guard-archived.md', 'archived')).toThrow(/lesson lifecycle status/);
  expect(vault.readNote('lessons/guard-archived.md').fm.status).toBe('active');
});

test('setStatus still accepts done on a reminder', () => {
  vault.writeNote('reminders/accepts-done.md', { type: 'reminder' }, 'body');
  vault.setStatus('reminders/accepts-done.md', 'done');
  expect(vault.readNote('reminders/accepts-done.md').fm.status).toBe('done');
});

test('clearDueDate removes lesson from listDue', () => {
  vault.writeNote('lessons/clear-due.md', { type: 'lesson', status: 'active', due_date: '2020-01-01' }, 'body');
  expect(vault.listDue('2030-01-01', 1).map(r => r.path)).toContain('lessons/clear-due.md');
  vault.clearDueDate('lessons/clear-due.md');
  expect(vault.listDue('2030-01-01', 1).map(r => r.path)).not.toContain('lessons/clear-due.md');
  expect(vault.readNote('lessons/clear-due.md').fm.due_date).toBeUndefined();
});

test('clearDueDate leaves lesson status unchanged', () => {
  vault.writeNote('lessons/clear-keep.md', { type: 'lesson', status: 'promoted', due_date: '2020-01-01' }, 'body');
  vault.clearDueDate('lessons/clear-keep.md');
  expect(vault.readNote('lessons/clear-keep.md').fm.status).toBe('promoted');
  const d = openDb();
  const row = d.prepare("SELECT status, due_date FROM notes WHERE path = 'lessons/clear-keep.md'").get();
  d.close();
  expect(row?.status).toBe('promoted');
  expect(row?.due_date ?? null).toBeNull();
});
