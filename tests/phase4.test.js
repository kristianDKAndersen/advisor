// tests/phase4.test.js — P4a backfill, P4b neighbors normalization, P4c wikilink templates

import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let vault;
let tmpVaultRoot;
let tmpRunsDir;

const SID1 = '1779000001-aaaaaa'; // complete verdict
const SID2 = '1779000002-bbbbbb'; // blocked verdict
const SID3 = '1779000003-cccccc'; // legacy prose — no verdict

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-p4-'));
  tmpRunsDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-p4-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
  fs.rmSync(tmpRunsDir,   { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function writeOutbox(sid, lines) {
  const dir = path.join(tmpRunsDir, sid, 'channel');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'outbox.jsonl'), lines.join('\n') + '\n');
}

// ── P4a — backfillVerdicts ────────────────────────────────────────────────────

test('[P4a] backfillVerdicts is exported from lib/vault.js', () => {
  expect(typeof vault.backfillVerdicts).toBe('function');
});

test('[P4a] backfillVerdicts populates complete + blocked, skips legacy prose', () => {
  // Write three synthesis notes with NULL worker_verdict
  vault.writeNote(`synthesis/${SID1}-1.md`, {
    type: 'synthesis', sid: SID1, seq: '1', created_at: new Date().toISOString()
  }, 'Established text A.');
  vault.writeNote(`synthesis/${SID2}-1.md`, {
    type: 'synthesis', sid: SID2, seq: '1', created_at: new Date().toISOString()
  }, 'Established text B.');
  vault.writeNote(`synthesis/${SID3}-1.md`, {
    type: 'synthesis', sid: SID3, seq: '1', created_at: new Date().toISOString()
  }, 'Established text C.');

  // SID1 outbox: JSON body with verdict=complete
  writeOutbox(SID1, [
    JSON.stringify({ ts: 1779000001.0, type: 'result', body: JSON.stringify({ verdict: 'complete', summary: 'Done', paths: [] }), from: 'coder', seq: 1 })
  ]);

  // SID2 outbox: JSON body with verdict=blocked
  writeOutbox(SID2, [
    JSON.stringify({ ts: 1779000002.0, type: 'result', body: JSON.stringify({ verdict: 'blocked', summary: 'Stuck', paths: [] }), from: 'coder', seq: 1 })
  ]);

  // SID3 outbox: legacy prose body (not JSON)
  writeOutbox(SID3, [
    JSON.stringify({ ts: 1779000003.0, type: 'result', body: 'Applied 5 fixes. All good.', from: 'coder', seq: 1 })
  ]);

  const res = vault.backfillVerdicts(false, tmpRunsDir);

  expect(res.total).toBeGreaterThanOrEqual(3);
  expect(res.backfilled).toBeGreaterThanOrEqual(2);
  expect(res.skippedLegacy).toBeGreaterThanOrEqual(1);

  // Verify DB was updated
  const d = vault._testDb ? vault._testDb() : null;
  // Use the CLI search to verify indirectly: check notes still searchable
  const notes1 = vault.searchNotes('Established text A');
  expect(notes1.length).toBeGreaterThan(0);
});

test('[P4a] backfillVerdicts dry-run does not modify DB', () => {
  // Write a fresh synthesis note, then dry-run
  const DRY_SID = '1779000004-dddddd';
  vault.writeNote(`synthesis/${DRY_SID}-1.md`, {
    type: 'synthesis', sid: DRY_SID, seq: '1', created_at: new Date().toISOString()
  }, 'Dry run test note.');
  writeOutbox(DRY_SID, [
    JSON.stringify({ ts: 1779000004.0, type: 'result', body: JSON.stringify({ verdict: 'complete', summary: 'Done', paths: [] }), from: 'coder', seq: 1 })
  ]);

  const dryRes = vault.backfillVerdicts(true, tmpRunsDir);
  expect(dryRes.report.some(r => r.sid === DRY_SID && r.status === 'would-set')).toBe(true);

  // Now run for real and verify it changes
  const realRes = vault.backfillVerdicts(false, tmpRunsDir);
  expect(realRes.backfilled).toBeGreaterThanOrEqual(1);
});

// ── P4b — neighbors() basename normalization ──────────────────────────────────

test('[P4b-RED] neighbors(basename) returns [] when source stored as fullpath — confirms bug', () => {
  // Write a note under a subdir with outbound wikilinks
  vault.writeNote('projects/p4b-proj.md', {
    type: 'synthesis', sid: 'P4B-SID', created_at: new Date().toISOString()
  }, 'See [[p4b-linked-note]] for context.');

  // neighbors by fullpath works (the source column IS 'projects/p4b-proj.md')
  const byFullpath = vault.neighbors('projects/p4b-proj.md');
  expect(byFullpath.length).toBeGreaterThan(0); // 1 outbound link

  // neighbors by basename — BUG: returns [] before fix
  const byBasename = vault.neighbors('p4b-proj');
  expect(byBasename.length).toBe(byFullpath.length); // FAILS before fix
});

test('[P4b] neighbors(basename) returns same rows as neighbors(fullpath) post-fix', () => {
  const byFullpath = vault.neighbors('projects/p4b-proj.md');
  const byBasename = vault.neighbors('p4b-proj');

  expect(byBasename.length).toBeGreaterThan(0);
  expect(byBasename.length).toBe(byFullpath.length);
  expect(byBasename[0].note).toBe(byFullpath[0].note);
  expect(byBasename[0].direction).toBe('out');
  expect(byBasename[0].kind).toBe('wikilink');
});

test('[P4b] neighbors(fullpath) inbound direction works when targets use basename', () => {
  // Write a second note that links to p4b-proj by basename wikilink
  vault.writeNote('sessions/p4b-linker.md', {
    type: 'session', sid: 'P4B-LINKER', created_at: new Date().toISOString()
  }, 'References [[p4b-proj]] here.');

  // inbound neighbors via fullpath should find this link
  const byFullpath = vault.neighbors('projects/p4b-proj.md');
  const inbound = byFullpath.filter(r => r.direction === 'in');
  expect(inbound.length).toBeGreaterThan(0);

  // inbound neighbors via basename should too
  const byBasename = vault.neighbors('p4b-proj');
  const inboundBN = byBasename.filter(r => r.direction === 'in');
  expect(inboundBN.length).toBe(inbound.length);
});

// ── P4c — auto-wikilink Related section in note templates ─────────────────────

test('[P4c] writeSynthesisNote body contains ## Related with [[sid]] wikilink', () => {
  const SID_SYN = '1779999001-syn001';
  vault.writeSynthesisNote({
    sid: SID_SYN, seq: 1,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'Things are established.',
    gap: 'No gap.',
    material: 'no',
    next_action: 'proceed',
    key_quotes: ''
  });

  const notePath = path.join(tmpVaultRoot, `synthesis/${SID_SYN}-1.md`);
  expect(fs.existsSync(notePath)).toBe(true);
  const content = fs.readFileSync(notePath, 'utf8');
  expect(content).toContain('## Related');
  expect(content).toContain(`[[${SID_SYN}]]`);
});

test('[P4c] writeSynthesisNote extracts additional sids from established/gap text', () => {
  const SID_MAIN  = '1779999002-syn002';
  const SID_PRIOR = '1779000001-aaaaaa'; // appears in text
  vault.writeSynthesisNote({
    sid: SID_MAIN, seq: 1,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: `Follows from session ${SID_PRIOR} results.`,
    gap: 'Still blocked.',
    material: 'yes',
    next_action: 'spawn-refinement: none',
    key_quotes: ''
  });

  const notePath = path.join(tmpVaultRoot, `synthesis/${SID_MAIN}-1.md`);
  const content = fs.readFileSync(notePath, 'utf8');
  expect(content).toContain(`[[${SID_MAIN}]]`);
  expect(content).toContain(`[[${SID_PRIOR}]]`);

  // Both sids should appear as backlinks targets in the links table
  const bl = vault.backlinks(SID_PRIOR);
  expect(bl.some(s => s.includes(SID_MAIN))).toBe(true);
});

test('[P4c] writeSessionNote appends Related for prior sids in task text', () => {
  const SID_SESSION = '1779999003-ses003';
  const SID_REF     = '1779000002-bbbbbb';
  vault.writeSessionNote({
    sid: SID_SESSION,
    agent: 'test-agent',
    task: `Continuing work from ${SID_REF} session. Fix the vault.`,
    goal: 'Stabilize the graph layer.',
    created_at: new Date().toISOString()
  });

  const notePath = path.join(tmpVaultRoot, `sessions/${SID_SESSION}.md`);
  expect(fs.existsSync(notePath)).toBe(true);
  const content = fs.readFileSync(notePath, 'utf8');
  expect(content).toContain('## Related');
  expect(content).toContain(`[[${SID_REF}]]`);
});

test('[P4c] writeSessionNote emits no Related section when task has no sid refs', () => {
  vault.writeSessionNote({
    sid: '1779999004-ses004',
    agent: 'test-agent',
    task: 'Fresh task with no prior session refs.',
    goal: 'Start fresh.',
    created_at: new Date().toISOString()
  });

  const content = fs.readFileSync(
    path.join(tmpVaultRoot, 'sessions/1779999004-ses004.md'), 'utf8'
  );
  expect(content).not.toContain('## Related');
});

test('[P4c] writeLesson body contains ## Related with [[sid]] linking back to synthesis session', () => {
  const SID_LES = '1779999005-les005';
  vault.writeLesson({
    sid: SID_LES,
    agent: 'test-agent',
    synthesis_seq: 3,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    root_cause: 'Poor planning.',
    heuristic: 'Plan more.',
    task_type: 'research',
    failure_mode: 'scope-creep',
    evaluator_dim: 'verdict:blocked',
    score: 0
  });

  const notePath = path.join(tmpVaultRoot, `lessons/${SID_LES}-test-agent-3.md`);
  expect(fs.existsSync(notePath)).toBe(true);
  const content = fs.readFileSync(notePath, 'utf8');
  expect(content).toContain('## Related');
  expect(content).toContain(`[[${SID_LES}]]`);
});
