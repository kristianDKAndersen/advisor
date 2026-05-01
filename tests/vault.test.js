import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpVaultRoot;

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
});

test('parseFrontmatter / serializeFrontmatter round-trip', () => {
  const fm = { type: 'synthesis', sid: 'test-sid', seq: '1' };
  const body = 'Round-trip body content.';
  const serialized = vault.serializeFrontmatter(fm, body);
  const { fm: parsed, body: parsedBody } = vault.parseFrontmatter(serialized);
  expect(parsed.type).toBe('synthesis');
  expect(parsed.sid).toBe('test-sid');
  expect(parsed.seq).toBe('1');
  expect(parsedBody.trim()).toBe(body);
});

test('writeSynthesisNote produces a file with valid frontmatter at expected path', () => {
  const record = {
    sid: 'VTEST-SID',
    seq: 1,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'Vault integration works as expected.',
    gap: 'none',
    material: 'no',
    next_action: 'proceed-to-step-8',
    key_quotes: ''
  };
  vault.writeSynthesisNote(record);
  const notePath = path.join(tmpVaultRoot, 'synthesis', 'VTEST-SID-1.md');
  expect(fs.existsSync(notePath)).toBe(true);
  const content = fs.readFileSync(notePath, 'utf8');
  const { fm } = vault.parseFrontmatter(content);
  expect(fm.type).toBe('synthesis');
  expect(fm.sid).toBe('VTEST-SID');
  expect(fm.seq).toBe('1');
  expect(fm.material).toBe('no');
  expect(fm.next_action).toBe('proceed-to-step-8');
});

test('searchNotes returns written record by FTS5 keyword', () => {
  const results = vault.searchNotes('Vault integration');
  expect(results.length).toBeGreaterThan(0);
  const match = results.find(r => r.path && r.path.includes('VTEST-SID'));
  expect(match).toBeDefined();
});

test('wikilink extraction populates links table; backlinks returns source', () => {
  const fm = {
    type: 'synthesis',
    sid: 'LINK-SID',
    seq: '1',
    created_at: new Date().toISOString()
  };
  const body = 'See [[TargetNote]] and [[AnotherNote]] for details.';
  vault.writeNote('synthesis/link-source.md', fm, body);
  const bl = vault.backlinks('TargetNote');
  expect(bl).toContain('synthesis/link-source.md');
});

test('indexPlanFile adds type:plan frontmatter to a plain .md file', () => {
  const planPath = path.join(tmpVaultRoot, 'test-plan.md');
  fs.writeFileSync(planPath, '# My Plan\n\nSome plan content here.');
  vault.indexPlanFile(planPath, 'my-test-plan');
  const content = fs.readFileSync(planPath, 'utf8');
  const { fm } = vault.parseFrontmatter(content);
  expect(fm.type).toBe('plan');
  expect(fm.plan_ref).toBe('my-test-plan');
  expect(fm.created_at).toBeDefined();
});

test('listUnresolved returns ghost link then clears when target note is written', () => {
  vault.writeNote('A.md', { type: 'note', created_at: new Date().toISOString() }, 'See [[ghost-note]] for details.');
  const before = vault.listUnresolved();
  const ghostRow = before.find(r => r.target === 'ghost-note');
  expect(ghostRow).toBeDefined();
  expect(ghostRow.source).toBe('A.md');

  vault.writeNote('ghost-note.md', { type: 'note', created_at: new Date().toISOString() }, 'Ghost resolved.');
  const after = vault.listUnresolved();
  expect(after.find(r => r.target === 'ghost-note')).toBeUndefined();
});

test('listDue returns past/near-term reminders and excludes far-future ones', () => {
  vault.writeNote('reminders/past-due.md', {
    type: 'reminder',
    due_date: '2020-01-01',
    created_at: new Date().toISOString(),
    title: 'Overdue reminder'
  }, 'This reminder is overdue.');
  vault.writeNote('reminders/future-due.md', {
    type: 'reminder',
    due_date: '2099-12-31',
    created_at: new Date().toISOString(),
    title: 'Far future reminder'
  }, 'This reminder is far in the future.');

  const today = '2026-05-01';
  const due = vault.listDue(today);
  const paths = due.map(r => r.path);
  expect(paths).toContain('reminders/past-due.md');
  expect(paths).not.toContain('reminders/future-due.md');
});
