// RED test: bitemporal annotation fields for synthesis notes (pattern 3.6).
// DoD: this file exits 1 until writeSynthesisNote, _upsertIndex, and the db()
// migration are updated to handle fetched_at, published_at, content_hash,
// t_valid, t_invalid.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpVaultRoot;

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bitemporal-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
});

const baseRecord = () => ({
  sid: 'BITEM-SID',
  seq: 1,
  ts: Date.now() / 1000,
  ts_iso: new Date().toISOString(),
  established: 'Bitemporal test content.',
  gap: 'test gap',
  material: 'yes',
  next_action: 'done',
  key_quotes: ''
});

// ── Test 1: all 5 fields present in input → appear in frontmatter ─────────────

test('writeSynthesisNote writes all 5 bitemporal fields to frontmatter', () => {
  const record = {
    ...baseRecord(),
    sid: 'BITEM-FULL',
    seq: 1,
    fetched_at: '2026-01-01T00:00:00Z',
    published_at: '2025-12-01T00:00:00Z',
    content_hash: 'abc123def456',
    t_valid: '2026-01-01T00:00:00Z',
    t_invalid: '9999-12-31T23:59:59Z'
  };
  vault.writeSynthesisNote(record);

  const notePath = path.join(tmpVaultRoot, 'synthesis', 'BITEM-FULL-1.md');
  expect(fs.existsSync(notePath)).toBe(true);

  const content = fs.readFileSync(notePath, 'utf8');
  const { fm } = vault.parseFrontmatter(content);

  expect(fm.fetched_at).toBe('2026-01-01T00:00:00Z');
  expect(fm.published_at).toBe('2025-12-01T00:00:00Z');
  expect(fm.content_hash).toBe('abc123def456');
  expect(fm.t_valid).toBe('2026-01-01T00:00:00Z');
  expect(fm.t_invalid).toBe('9999-12-31T23:59:59Z');
});

// ── Test 2: missing bitemporal fields → '' in frontmatter (not undefined/null) ─

test('writeSynthesisNote writes empty string for missing bitemporal fields', () => {
  const record = {
    ...baseRecord(),
    sid: 'BITEM-MISSING',
    seq: 2
    // intentionally omit: fetched_at, published_at, content_hash, t_valid, t_invalid
  };
  vault.writeSynthesisNote(record);

  const notePath = path.join(tmpVaultRoot, 'synthesis', 'BITEM-MISSING-2.md');
  expect(fs.existsSync(notePath)).toBe(true);

  const content = fs.readFileSync(notePath, 'utf8');
  const { fm } = vault.parseFrontmatter(content);

  expect(fm.fetched_at).toBe('');
  expect(fm.published_at).toBe('');
  expect(fm.content_hash).toBe('');
  expect(fm.t_valid).toBe('');
  expect(fm.t_invalid).toBe('');
});

// ── Test 3: round-trip via readNote returns exact bitemporal strings ───────────

test('round-trip via readNote returns exact bitemporal field strings', () => {
  const record = {
    ...baseRecord(),
    sid: 'BITEM-RT',
    seq: 3,
    fetched_at: '2026-05-07T10:00:00Z',
    published_at: '2026-04-01T00:00:00Z',
    content_hash: 'deadbeef1234',
    t_valid: '2026-05-07T10:00:00Z',
    t_invalid: '9999-12-31T23:59:59Z'
  };
  vault.writeSynthesisNote(record);

  const note = vault.readNote('synthesis/BITEM-RT-3.md');
  expect(note).not.toBeNull();

  expect(note.fm.fetched_at).toBe('2026-05-07T10:00:00Z');
  expect(note.fm.published_at).toBe('2026-04-01T00:00:00Z');
  expect(note.fm.content_hash).toBe('deadbeef1234');
  expect(note.fm.t_valid).toBe('2026-05-07T10:00:00Z');
  expect(note.fm.t_invalid).toBe('9999-12-31T23:59:59Z');
});

// ── Test 4a: SQLite notes table has all 5 new columns ────────────────────────

test('SQLite notes table has the 5 bitemporal columns', () => {
  // Ensure db is initialised by writing a note.
  vault.writeSynthesisNote({ ...baseRecord(), sid: 'BITEM-DBINIT', seq: 4 });

  const dbPath = path.join(tmpVaultRoot, '.cache', 'vault.db');
  const testDb = new Database(dbPath);
  const cols = testDb.prepare('PRAGMA table_info(notes)').all().map(r => r.name);
  testDb.close();

  expect(cols).toContain('fetched_at');
  expect(cols).toContain('published_at');
  expect(cols).toContain('content_hash');
  expect(cols).toContain('t_valid');
  expect(cols).toContain('t_invalid');
});

// ── Test 4b: INSERT stores bitemporal values in SQLite ─────────────────────────

test('SQLite INSERT stores bitemporal values written via writeSynthesisNote', () => {
  const record = {
    ...baseRecord(),
    sid: 'BITEM-STORE',
    seq: 5,
    fetched_at: '2026-05-07T12:00:00Z',
    published_at: '2026-03-15T00:00:00Z',
    content_hash: 'cafebabe0000',
    t_valid: '2026-05-07T12:00:00Z',
    t_invalid: ''
  };
  vault.writeSynthesisNote(record);

  const dbPath = path.join(tmpVaultRoot, '.cache', 'vault.db');
  const testDb = new Database(dbPath);
  const row = testDb.prepare(
    'SELECT fetched_at, published_at, content_hash, t_valid, t_invalid FROM notes WHERE path = ?'
  ).get('synthesis/BITEM-STORE-5.md');
  testDb.close();

  expect(row).not.toBeNull();
  expect(row.fetched_at).toBe('2026-05-07T12:00:00Z');
  expect(row.published_at).toBe('2026-03-15T00:00:00Z');
  expect(row.content_hash).toBe('cafebabe0000');
  expect(row.t_valid).toBe('2026-05-07T12:00:00Z');
  expect(row.t_invalid).toBe('');
});
