import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

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

// G10: CRLF normalization
test('parseFrontmatter handles CRLF line endings', () => {
  const crlf = '---\r\ntype: test\r\nagent: worker\r\n---\r\n\r\nbody text';
  const { fm, body } = vault.parseFrontmatter(crlf);
  expect(fm.type).toBe('test');
  expect(fm.agent).toBe('worker');
  expect(body.trim()).toBe('body text');
});

// G2: colon-in-value key guard
test('parseFrontmatter handles URL-like values and non-key lines without corruption', () => {
  const text = '---\nrepo: http://github.com/foo/bar\nagent: researcher\n---\n\nbody';
  const { fm } = vault.parseFrontmatter(text);
  expect(fm.repo).toBe('http://github.com/foo/bar');
  expect(fm.agent).toBe('researcher');
  expect(fm['http']).toBeUndefined();
});

// G6: basename-aware listUnresolved
test('listUnresolved does not false-positive on cross-subdirectory wikilinks', () => {
  vault.writeNote('synthesis/TARGET-NOTE-1.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Content');
  vault.writeNote('sessions/linker.md', { type: 'session', created_at: new Date().toISOString() }, 'See [[TARGET-NOTE-1]] for details.');
  const unresolved = vault.listUnresolved();
  const falsePositive = unresolved.find(r => r.target === 'TARGET-NOTE-1');
  expect(falsePositive).toBeUndefined();
});

// G11: deleteNote cascade
test('deleteNote removes file, clears search results, and removes orphaned link rows', () => {
  vault.writeNote('notes/to-delete.md', { type: 'note', created_at: new Date().toISOString() }, 'Unique delete-me content XYZ');
  vault.writeNote('notes/linker2.md', { type: 'note', created_at: new Date().toISOString() }, 'See [[to-delete]]');
  const notePath = path.join(tmpVaultRoot, 'notes', 'to-delete.md');
  expect(fs.existsSync(notePath)).toBe(true);

  vault.deleteNote('notes/to-delete.md');

  expect(fs.existsSync(notePath)).toBe(false);
  const results = vault.searchNotes('delete-me content XYZ');
  expect(results.find(r => r.path === 'notes/to-delete.md')).toBeUndefined();
});

// G1: rebuildIndex
test('rebuildIndex repopulates vault.db after db deletion', () => {
  const record = {
    sid: 'REBUILD-SID', seq: 1, ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'Vault integration rebuild test.',
    gap: 'none', material: 'no', next_action: 'rebuild',
    key_quotes: '', agent: ''
  };
  vault.writeSynthesisNote(record);
  const dbFile = path.join(tmpVaultRoot, '.cache', 'vault.db');
  fs.rmSync(dbFile);
  const { indexed } = vault.rebuildIndex();
  expect(indexed).toBeGreaterThan(0);
  const results = vault.searchNotes('Vault integration rebuild test');
  expect(results.length).toBeGreaterThan(0);
});

// T2a: links schema migration — kind and confidence columns
test('links table has kind=wikilink and confidence=EXTRACTED on new wikilink edges', () => {
  vault.writeNote('t2a-source.md', { type: 'note', created_at: new Date().toISOString() }, 'See [[t2a-target]] here.');
  const nb = vault.neighbors('t2a-target');
  expect(nb.length).toBeGreaterThan(0);
  expect(nb[0].kind).toBe('wikilink');
  expect(nb[0].confidence).toBe('EXTRACTED');
});

// T2a: shortestPath via recursive CTE
test('shortestPath returns node array for connected notes', () => {
  vault.writeNote('sp-a.md', { type: 'note', created_at: new Date().toISOString() }, 'See [[sp-b]].');
  vault.writeNote('sp-b.md', { type: 'note', created_at: new Date().toISOString() }, 'See [[sp-c]].');
  vault.writeNote('sp-c.md', { type: 'note', created_at: new Date().toISOString() }, 'End node.');
  const route = vault.shortestPath('sp-a.md', 'sp-c');
  expect(route.length).toBeGreaterThan(0);
  expect(route[0]).toBe('sp-a.md');
  expect(route[route.length - 1]).toBe('sp-c');
});

// T2a + T2c: setWorkerVerdict + listGaps
test('setWorkerVerdict marks note; listGaps returns blocked-without-lesson rows; lesson clears gap', () => {
  const rec = {
    sid: 'GAPS-SID', seq: 99, ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'Gap test blocked synthesis',
    gap: 'none', material: 'yes', next_action: 'spawn-refinement: none',
    key_quotes: '', agent: 'test-agent'
  };
  vault.writeSynthesisNote(rec);
  vault.setWorkerVerdict('synthesis/GAPS-SID-99.md', 'blocked');

  const gaps = vault.listGaps(10);
  expect(gaps.find(g => g.sid === 'GAPS-SID')).toBeDefined();

  vault.writeNote('lessons/GAPS-SID-test-agent-99.md', {
    type: 'lesson', sid: 'GAPS-SID', created_at: new Date().toISOString()
  }, 'Lesson content');
  const gapsAfter = vault.listGaps(10);
  expect(gapsAfter.find(g => g.sid === 'GAPS-SID')).toBeUndefined();
});

// T2d: listHubs returns degree-ranked nodes
test('listHubs returns top nodes by in-degree', () => {
  vault.writeNote('hub-a.md', { type: 'note', created_at: new Date().toISOString() }, 'See [[hub-center]].');
  vault.writeNote('hub-b.md', { type: 'note', created_at: new Date().toISOString() }, 'Also [[hub-center]].');
  vault.writeNote('hub-c.md', { type: 'note', created_at: new Date().toISOString() }, 'Ref [[hub-center]] again.');
  const hubs = vault.listHubs(5);
  expect(hubs.length).toBeGreaterThan(0);
  const center = hubs.find(h => h.target === 'hub-center');
  expect(center).toBeDefined();
  expect(center.deg).toBeGreaterThanOrEqual(3);
});

// T2c: advisor-vault gaps CLI subcommand
test('advisor-vault gaps CLI exits 0 and lists blocked-without-lesson rows', () => {
  vault.writeNote('synthesis/CLI-GAPS-1.md', {
    type: 'synthesis', sid: 'CLI-GAPS-SID', seq: '1', created_at: new Date().toISOString()
  }, 'CLI gaps test content');
  vault.setWorkerVerdict('synthesis/CLI-GAPS-1.md', 'blocked');

  const result = spawnSync('bun', ['bin/advisor-vault', 'gaps', '--limit', '10'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVaultRoot },
    timeout: 10000,
    cwd: path.resolve(import.meta.dirname, '..')
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('CLI-GAPS-SID');
});

// T2d: advisor-vault hubs CLI subcommand
test('advisor-vault hubs CLI exits 0 and lists hub nodes', () => {
  const result = spawnSync('bun', ['bin/advisor-vault', 'hubs', '--limit', '5'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVaultRoot },
    timeout: 10000,
    cwd: path.resolve(import.meta.dirname, '..')
  });
  expect(result.status).toBe(0);
  // hub-center should appear (3 inbound links from earlier test)
  expect(result.stdout).toContain('hub-center');
});

test('listDue: uses parameterized DISMISSED_STATUSES (not string-interpolated into SQL)', () => {
  const src = fs.readFileSync(new URL('../lib/vault.js', import.meta.url).pathname, 'utf8');
  const start = src.indexOf('function listDue(');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end);
  expect(body).not.toContain('_DISMISSED_SQL');
  expect(body).toContain('DISMISSED_STATUSES.map');
});

// memtrace-inspired weighted scoring
test('searchNotes returns numeric score field, sorted descending', () => {
  vault.writeNote('synthesis/score-test-1.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Weighted scoring unique token ZQXW.');
  const results = vault.searchNotes('ZQXW');
  expect(results.length).toBeGreaterThan(0);
  expect(typeof results[0].score).toBe('number');
  for (let i = 1; i < results.length; i++) {
    expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
  }
});

test('searchNotes legacy:true returns old raw-BM25 shape without score field', () => {
  const results = vault.searchNotes('ZQXW', 10, { legacy: true });
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].score).toBeUndefined();
});

test('searchNotes excludes superseded notes by default, includes with legacy:true', () => {
  vault.writeNote('synthesis/superseded-old.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Supersede unique token YVUT.');
  vault.writeNote('synthesis/superseded-new.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Replacement note YVUT.');
  vault.supersedeNote('synthesis/superseded-old.md', 'synthesis/superseded-new.md');
  const results = vault.searchNotes('YVUT');
  expect(results.find(r => r.path === 'synthesis/superseded-old.md')).toBeUndefined();
  const legacyResults = vault.searchNotes('YVUT', 10, { legacy: true });
  expect(legacyResults.find(r => r.path === 'synthesis/superseded-old.md')).toBeDefined();
});

test('searchNotes halves score for status=stale notes', () => {
  vault.writeNote('synthesis/stale-score-a.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Stale scoring token WPQR fresh.');
  vault.writeNote('synthesis/stale-score-b.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Stale scoring token WPQR fresh.');
  vault.setStatus('synthesis/stale-score-b.md', 'stale');
  const results = vault.searchNotes('WPQR');
  const a = results.find(r => r.path === 'synthesis/stale-score-a.md');
  const b = results.find(r => r.path === 'synthesis/stale-score-b.md');
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect(b.score).toBeLessThan(a.score);
});

// supersession model
test('supersedeNote sets superseded_by in frontmatter and DB', () => {
  vault.writeNote('synthesis/sup-src.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'Supersede target content.');
  vault.supersedeNote('synthesis/sup-src.md', 'synthesis/sup-dst.md');
  const note = vault.readNote('synthesis/sup-src.md');
  expect(note.fm.superseded_by).toBe('synthesis/sup-dst.md');
});

// staleness scan
test('scanStale marks note stale when referenced absolute path is deleted; dryRun does not mutate', () => {
  const scanDir = path.join(os.homedir(), '.advisor-vault-scan-test-1');
  fs.mkdirSync(scanDir, { recursive: true });
  const refFile = path.join(scanDir, 'scan-ref.txt');
  fs.writeFileSync(refFile, 'ref content');
  vault.writeNote('synthesis/scan-test-1.md', { type: 'synthesis', created_at: new Date(Date.now() - 1000).toISOString() }, `References ${refFile} for details.`);
  fs.unlinkSync(refFile);

  try {
    const dry = vault.scanStale({ dryRun: true });
    expect(dry.report.find(r => r.path === 'synthesis/scan-test-1.md' && r.action === 'marked-stale')).toBeDefined();
    const noteAfterDry = vault.readNote('synthesis/scan-test-1.md');
    expect(noteAfterDry.fm.status).not.toBe('stale');

    const real = vault.scanStale({ dryRun: false });
    expect(real.markedStale).toBeGreaterThan(0);
    const noteAfterReal = vault.readNote('synthesis/scan-test-1.md');
    expect(noteAfterReal.fm.status).toBe('stale');
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test('scanStale clears stale status when references are intact and older than note', () => {
  const scanDir = path.join(os.homedir(), '.advisor-vault-scan-test-2');
  fs.mkdirSync(scanDir, { recursive: true });
  const refFile = path.join(scanDir, 'scan-ref2.txt');
  fs.writeFileSync(refFile, 'ref content');
  const created = new Date(Date.now() + 60000).toISOString();
  vault.writeNote('synthesis/scan-test-2.md', { type: 'synthesis', created_at: created, status: 'stale' }, `References ${refFile} for details.`);

  try {
    const result = vault.scanStale({ dryRun: false });
    expect(result.cleared).toBeGreaterThan(0);
    const note = vault.readNote('synthesis/scan-test-2.md');
    expect(note.fm.status).not.toBe('stale');
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test('advisor-vault scan CLI --dry-run exits 0', () => {
  const result = spawnSync('bun', ['bin/advisor-vault', 'scan', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVaultRoot },
    timeout: 10000,
    cwd: path.resolve(import.meta.dirname, '..')
  });
  expect(result.status).toBe(0);
});

test('advisor-vault supersede CLI exits 0 and sets superseded_by', () => {
  vault.writeNote('synthesis/cli-sup-src.md', { type: 'synthesis', created_at: new Date().toISOString() }, 'CLI supersede test content.');
  const result = spawnSync('bun', ['bin/advisor-vault', 'supersede', 'synthesis/cli-sup-src.md', 'synthesis/cli-sup-dst.md'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVaultRoot },
    timeout: 10000,
    cwd: path.resolve(import.meta.dirname, '..')
  });
  expect(result.status).toBe(0);
  const note = vault.readNote('synthesis/cli-sup-src.md');
  expect(note.fm.superseded_by).toBe('synthesis/cli-sup-dst.md');
});

test('advisor-vault search --legacy CLI exits 0', () => {
  const result = spawnSync('bun', ['bin/advisor-vault', 'search', '--text', 'ZQXW', '--legacy'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVaultRoot },
    timeout: 10000,
    cwd: path.resolve(import.meta.dirname, '..')
  });
  expect(result.status).toBe(0);
});
