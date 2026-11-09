// Tests for lib/maintenance.js — the testable selection + archiving logic used
// by the SessionStart hook (.claude/hooks/session-start.js).
//
// Scenarios:
//   (1) pickLastSession: first dir with a valid session.json, skipping
//       plans/_archive and dirs lacking session.json.
//   (2) newestUnresolvedHandover: newest UNRESOLVED handover surfaced; resolved skipped.
//   (3) archiveResolvedHandovers: resolved handover >24h moved to _archive; <24h kept.
//   (4) archiveStaleReminders: reminder >30d past due archived (status flip) and
//       absent from listDue; a recent reminder untouched.
//   (5) INTEGRATION: run the real hook under `node` and confirm the stale reminder's
//       status flipped + dropped from listDue (catches the bun:sqlite-under-node gap).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = path.resolve(import.meta.dir, '../.claude/hooks/session-start.js');

let maintenance;
let vault;
let tmpVault;

beforeAll(async () => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-vault-'));
  process.env.ADVISOR_VAULT = tmpVault;
  vault = await import('../lib/vault.js');
  maintenance = await import('../lib/maintenance.js');
});

afterAll(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

function mkRuns(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function touch(p, secondsFromBase) {
  // base epoch chosen far in the past so relative ordering is unambiguous
  const t = new Date((1_700_000_000 + secondsFromBase) * 1000);
  fs.utimesSync(p, t, t);
}
function daysBefore(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * 86_400_000).toISOString().slice(0, 10);
}

// ── (1) last session selection ───────────────────────────────────────────────
test('pickLastSession picks first dir with session.json, skipping plans/_archive/no-session', () => {
  const runs = mkRuns('maint-runs1-');

  // newest overall, but must be skipped by name
  fs.mkdirSync(path.join(runs, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'plans', 'x.md'), 'x');
  fs.mkdirSync(path.join(runs, '_archive'), { recursive: true });

  // a workspace UUID dir with NO session.json (newest among session candidates)
  fs.mkdirSync(path.join(runs, 'workspace-uuid'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'workspace-uuid', 'note.txt'), 'no session here');

  // the real, valid session (older)
  fs.mkdirSync(path.join(runs, 'sess-A'), { recursive: true });
  fs.writeFileSync(
    path.join(runs, 'sess-A', 'session.json'),
    JSON.stringify({ tier: 'T1', next_action: 'do-x', decomposition: [{ status: 'complete' }, { status: 'pending' }] })
  );

  // set mtimes last (writes bump dir mtime). plans newest, then _archive, then nosession, then sess-A.
  touch(path.join(runs, 'sess-A'), 1000);
  touch(path.join(runs, 'workspace-uuid'), 2000);
  touch(path.join(runs, '_archive'), 2500);
  touch(path.join(runs, 'plans'), 3000);

  const picked = maintenance.pickLastSession(runs);
  expect(picked).not.toBeNull();
  expect(picked.sid).toBe('sess-A');
  expect(picked.session.tier).toBe('T1');
  expect(picked.session.next_action).toBe('do-x');

  fs.rmSync(runs, { recursive: true, force: true });
});

test('pickLastSession returns null when no dir has a valid session.json', () => {
  const runs = mkRuns('maint-runs1b-');
  fs.mkdirSync(path.join(runs, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(runs, 'workspace-uuid'), { recursive: true });
  expect(maintenance.pickLastSession(runs)).toBeNull();
  fs.rmSync(runs, { recursive: true, force: true });
});

// ── (2) newest unresolved handover ───────────────────────────────────────────
test('newestUnresolvedHandover surfaces newest unresolved, skips resolved', () => {
  const runs = mkRuns('maint-runs2-');
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });

  fs.writeFileSync(path.join(plans, 'handover-old.md'), 'work in progress, no outcome yet');
  fs.writeFileSync(path.join(plans, 'handover-new.md'), 'still open, needs more work');
  fs.writeFileSync(path.join(plans, 'handover-resolved.md'), 'all done.\n\nFINAL OUTCOME: shipped');
  fs.writeFileSync(path.join(plans, 'some-plan.md'), 'not a handover (no keyword)');
  // archived handover must be ignored (subdir, top-level scan only)
  fs.mkdirSync(path.join(plans, '_archive'), { recursive: true });
  fs.writeFileSync(path.join(plans, '_archive', 'handover-buried.md'), 'open but archived');

  touch(path.join(plans, 'handover-old.md'), 1000);
  touch(path.join(plans, 'handover-new.md'), 2000);
  touch(path.join(plans, 'handover-resolved.md'), 3000); // newest, but resolved

  const open = maintenance.newestUnresolvedHandover(runs);
  expect(open).not.toBeNull();
  expect(path.basename(open)).toBe('handover-new.md');

  fs.rmSync(runs, { recursive: true, force: true });
});

test('newestUnresolvedHandover returns null when all handovers resolved', () => {
  const runs = mkRuns('maint-runs2b-');
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, 'handover-done.md'), 'FINAL OUTCOME: complete');
  expect(maintenance.newestUnresolvedHandover(runs)).toBeNull();
  fs.rmSync(runs, { recursive: true, force: true });
});

// ── (3) archive resolved handovers older than 24h ────────────────────────────
test('archiveResolvedHandovers moves resolved >24h to _archive, keeps <24h and unresolved', () => {
  const runs = mkRuns('maint-runs3-');
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });

  const oldRes = path.join(plans, 'handover-res-old.md');
  const freshRes = path.join(plans, 'handover-res-fresh.md');
  const oldUnres = path.join(plans, 'handover-unres-old.md');
  fs.writeFileSync(oldRes, 'FINAL OUTCOME: done long ago');
  fs.writeFileSync(freshRes, 'FINAL OUTCOME: done just now');
  fs.writeFileSync(oldUnres, 'still open from long ago');

  const old = new Date(Date.now() - 48 * 3600 * 1000); // 48h ago
  fs.utimesSync(oldRes, old, old);
  fs.utimesSync(oldUnres, old, old);
  // freshRes keeps its just-created mtime (< 24h)

  const moved = maintenance.archiveResolvedHandovers(runs).moved;
  expect(moved).toBe(1);

  expect(fs.existsSync(oldRes)).toBe(false);
  expect(fs.existsSync(path.join(plans, '_archive', 'handover-res-old.md'))).toBe(true);
  expect(fs.existsSync(freshRes)).toBe(true);       // resolved but fresh — kept
  expect(fs.existsSync(oldUnres)).toBe(true);       // unresolved — never moved

  fs.rmSync(runs, { recursive: true, force: true });
});

// ── (4) archive stale reminders (status flip + index update) ─────────────────
test('archiveStaleReminders archives >30d-past-due reminder; recent untouched; listDue reflects it', () => {
  const today = '2026-06-10';
  const staleDue = daysBefore(today, 40);
  const recentDue = daysBefore(today, 5);

  vault.writeNote('reminders/stale.md', { type: 'reminder', due_date: staleDue, created_at: '2026-01-01T00:00:00Z' }, 'stale reminder body');
  vault.writeNote('reminders/recent.md', { type: 'reminder', due_date: recentDue, created_at: '2026-06-01T00:00:00Z' }, 'recent reminder body');

  // sanity: both visible before archiving
  const before = vault.listDue(today).map((n) => n.path);
  expect(before).toContain('reminders/stale.md');
  expect(before).toContain('reminders/recent.md');

  const n = maintenance.archiveStaleReminders(vault, today);
  expect(n).toBe(1);

  // behavioral: stale gone from listDue, recent still present
  const after = vault.listDue(today).map((n) => n.path);
  expect(after).not.toContain('reminders/stale.md');
  expect(after).toContain('reminders/recent.md');

  // status flipped on the stale note; recent untouched
  expect(vault.readNote('reminders/stale.md').fm.status).toBe('archived');
  expect(vault.readNote('reminders/recent.md').fm.status).not.toBe('archived');
});

test('archiveStaleReminders clears due_date on overdue lesson instead of archiving', () => {
  const today = '2026-06-10';
  vault.writeNote('lessons/overdue-a.md', { type: 'lesson', status: 'active', due_date: daysBefore(today, 40), created_at: '2026-01-01T00:00:00Z' }, 'overdue lesson alpha');
  expect(vault.listDue(today).map((n) => n.path)).toContain('lessons/overdue-a.md');

  maintenance.archiveStaleReminders(vault, today);

  const note = vault.readNote('lessons/overdue-a.md');
  expect(note.fm.due_date).toBeUndefined();
  expect(note.fm.status).toBe('active');
  expect(vault.listDue(today).map((n) => n.path)).not.toContain('lessons/overdue-a.md');
});

test('overdue lesson keeps its status and stays searchable', () => {
  const today = '2026-06-10';
  vault.writeNote('lessons/overdue-b.md', { type: 'lesson', status: 'proposed', due_date: daysBefore(today, 60), created_at: '2026-01-01T00:00:00Z' }, 'zymurgyquux heuristic');

  maintenance.archiveStaleReminders(vault, today);

  expect(vault.readNote('lessons/overdue-b.md').fm.status).toBe('proposed');
  expect(vault.searchNotes('zymurgyquux').map((r) => r.path)).toContain('lessons/overdue-b.md');
});

test('overdue reminder is still archived', () => {
  const today = '2026-06-10';
  vault.writeNote('reminders/overdue-c.md', { type: 'reminder', due_date: daysBefore(today, 50), created_at: '2026-01-01T00:00:00Z' }, 'old reminder c');
  vault.writeNote('lessons/overdue-d.md', { type: 'lesson', status: 'active', due_date: daysBefore(today, 50), created_at: '2026-01-01T00:00:00Z' }, 'lesson d');

  const n = maintenance.archiveStaleReminders(vault, today);

  expect(n).toBe(1);
  expect(vault.readNote('reminders/overdue-c.md').fm.status).toBe('archived');
});

// ── (5) integration: hook runs under node and D actually executes under bun ───
test('INTEGRATION: session-start.js under node flips a stale reminder and drops it from listDue', () => {
  const intVault = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-intvault-'));
  const intRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-intruns-'));

  // seed a >30d-past-due reminder in the integration vault (real today, since the
  // hook uses the live date). Switch ADVISOR_VAULT so our vault module targets it.
  const prevVault = process.env.ADVISOR_VAULT;
  process.env.ADVISOR_VAULT = intVault;
  const realToday = new Date().toISOString().slice(0, 10);
  const staleDue = daysBefore(realToday, 45);
  vault.writeNote('reminders/int-stale.md', { type: 'reminder', due_date: staleDue, created_at: '2026-01-01T00:00:00Z' }, 'integration stale reminder');
  expect(vault.listDue(realToday).map((x) => x.path)).toContain('reminders/int-stale.md');

  // run the REAL hook under its real interpreter (node)
  const r = spawnSync('node', [HOOK], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: intRuns, ADVISOR_VAULT: intVault },
    timeout: 15000,
  });
  expect(r.status).toBe(0);

  // file is source of truth: status flipped to archived
  expect(vault.readNote('reminders/int-stale.md').fm.status).toBe('archived');
  // rebuild from disk to read the post-subprocess state, then confirm it dropped from listDue
  vault.rebuildIndex();
  expect(vault.listDue(realToday).map((x) => x.path)).not.toContain('reminders/int-stale.md');

  process.env.ADVISOR_VAULT = prevVault;
  fs.rmSync(intVault, { recursive: true, force: true });
  fs.rmSync(intRuns, { recursive: true, force: true });
});

// ── (6) header-aware handover scan, stale-open archive, temp cleanup ─────────
// Every test below passes an fs.mkdtempSync runs root; ADVISOR_RUNS_ROOT is
// pointed at a temp dir too so nothing can fall back to the real ~/.advisor/runs.
import { renderHeader } from '../lib/handover.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const NOW_S = NOW / 1000;
const DAY_S = 86_400;

let hvEnvRoot;
beforeAll(() => {
  hvEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-hvenv-'));
  process.env.ADVISOR_RUNS_ROOT = hvEnvRoot;
});
afterAll(() => {
  fs.rmSync(hvEnvRoot, { recursive: true, force: true });
});

function mkPlans(prefix) {
  const runs = mkRuns(prefix);
  const plans = path.join(runs, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  return { runs, plans };
}
// Write a handover file; `ageDays`/`ageSeconds` set its mtime relative to NOW.
function put(dir, name, content, mtimeAgoS = 0) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  const t = new Date((NOW_S - mtimeAgoS) * 1000);
  fs.utimesSync(p, t, t);
  return p;
}
function headered(fields, body = '# Handover\n\nbody text\n') {
  return renderHeader(fields) + body;
}
const openHdr = (createdAgoS, extra = {}) => headered({ status: 'open', created: NOW_S - createdAgoS, sid: 's1', ...extra });
const resolvedHdr = (resolvedAgoS) =>
  headered({ status: 'resolved', created: NOW_S - 90 * DAY_S, sid: 's1', resolved: NOW_S - resolvedAgoS, outcome: 'done' });

test('listHandovers classifies header-open, header-resolved, legacy line, legacy heading, legacy mid-line, invalid, empty', () => {
  const { runs, plans } = mkPlans('maint-hv1-');
  put(plans, 'a-handover.md', openHdr(DAY_S), 0);
  put(plans, 'b-handover.md', resolvedHdr(3600), 0);
  put(plans, 'c-handover.md', '# t\n\nFINAL OUTCOME: shipped\n', 2 * DAY_S);
  put(plans, 'd-handover.md', '# t\n\n## FINAL OUTCOME\nshipped\n', 2 * DAY_S);
  put(plans, 'e-handover.md', '# t\n\nPrevious one still lacks FINAL OUTCOME marker.\n', 2 * DAY_S);
  put(plans, 'f-handover.md', headered({ status: 'maybe', created: NOW_S }), 0);
  put(plans, 'g-handover.md', '', 3600);

  const maintenance_ = maintenance;
  const by = Object.fromEntries(maintenance_.listHandovers(runs, NOW).map((h) => [h.name, h]));
  expect(Object.keys(by).sort()).toEqual(['a-handover.md', 'b-handover.md', 'c-handover.md', 'd-handover.md', 'e-handover.md', 'f-handover.md', 'g-handover.md']);

  expect([by['a-handover.md'].status, by['a-handover.md'].resolved, by['a-handover.md'].kind, by['a-handover.md'].valid]).toEqual(['open', false, 'header', true]);
  expect(by['a-handover.md'].createdMs).toBe((NOW_S - DAY_S) * 1000);
  expect([by['b-handover.md'].status, by['b-handover.md'].resolved]).toEqual(['resolved', true]);
  expect(by['b-handover.md'].resolvedMs).toBe((NOW_S - 3600) * 1000);
  expect([by['c-handover.md'].status, by['c-handover.md'].resolved, by['c-handover.md'].kind]).toEqual(['resolved', true, 'legacy']);
  expect([by['d-handover.md'].status, by['d-handover.md'].resolved]).toEqual(['resolved', true]);
  expect([by['e-handover.md'].status, by['e-handover.md'].resolved, by['e-handover.md'].valid]).toEqual(['open', false, true]);
  expect([by['f-handover.md'].status, by['f-handover.md'].resolved, by['f-handover.md'].valid, by['f-handover.md'].reason]).toEqual(['invalid', false, false, 'bad-status']);
  expect([by['g-handover.md'].status, by['g-handover.md'].kind, by['g-handover.md'].valid, by['g-handover.md'].reason]).toEqual(['invalid', 'empty', false, 'empty']);
  expect(maintenance.RESOLVED_RE.test('x FINAL OUTCOME y')).toBe(false);
  expect(maintenance.RESOLVED_RE.test('FINAL OUTCOME: y')).toBe(true);

  fs.rmSync(runs, { recursive: true, force: true });
});

test('newestUnresolvedHandover ignores invalid and empty and orders headered by created, legacy by mtime', () => {
  const { runs, plans } = mkPlans('maint-hv2-');
  put(plans, 'a-handover.md', openHdr(5 * DAY_S), 0); // old created, fresh mtime
  put(plans, 'b-handover.md', 'legacy newer\n', 2 * DAY_S);
  put(plans, 'c-handover.md', 'legacy older\n', 4 * DAY_S);
  put(plans, 'd-handover.md', headered({ status: 'bogus', created: NOW_S }), 0); // invalid, newest
  put(plans, 'e-handover.md', '', 0); // empty, newest
  expect(path.basename(maintenance.newestUnresolvedHandover(runs, NOW))).toBe('b-handover.md');

  put(plans, 'f-handover.md', openHdr(3600), 40 * DAY_S); // recent created, ancient mtime
  expect(path.basename(maintenance.newestUnresolvedHandover(runs, NOW))).toBe('f-handover.md');

  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveResolvedHandovers uses header resolved epoch not mtime', () => {
  const { runs, plans } = mkPlans('maint-hv3-');
  put(plans, 'old-resolved-handover.md', resolvedHdr(2 * DAY_S), 0); // resolved 2d ago, mtime fresh
  put(plans, 'new-resolved-handover.md', resolvedHdr(3600), 10 * DAY_S); // resolved 1h ago, mtime ancient
  expect(maintenance.archiveResolvedHandovers(runs, NOW).moved).toBe(1);
  expect(fs.existsSync(path.join(plans, '_archive', 'old-resolved-handover.md'))).toBe(true);
  expect(fs.existsSync(path.join(plans, 'new-resolved-handover.md'))).toBe(true);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveResolvedHandovers records resolved-24h in archived header', () => {
  const { runs, plans } = mkPlans('maint-hv4-');
  const body = '# Handover\n\nbody text\n';
  put(plans, 'r-handover.md', resolvedHdr(2 * DAY_S), 0);
  expect(maintenance.archiveResolvedHandovers(runs, NOW).moved).toBe(1);
  const archived = fs.readFileSync(path.join(plans, '_archive', 'r-handover.md'), 'utf8');
  expect(archived).toContain('archive_reason: resolved-24h');
  expect(archived).toContain(`archived: ${NOW_S}`);
  expect(archived).toContain('status: resolved');
  expect(archived.endsWith(body)).toBe(true);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveStaleOpenHandovers moves header-open >30d and legacy-open mtime >30d, keeps exactly 30d, never moves invalid', () => {
  const { runs, plans } = mkPlans('maint-hv5-');
  put(plans, 'hdr-old-handover.md', openHdr(31 * DAY_S), 31 * DAY_S);
  put(plans, 'hdr-edge-handover.md', openHdr(30 * DAY_S), 30 * DAY_S);
  put(plans, 'leg-old-handover.md', 'legacy old\n', 31 * DAY_S);
  put(plans, 'leg-edge-handover.md', 'legacy edge\n', 30 * DAY_S);
  put(plans, 'bad-handover.md', headered({ status: 'bogus', created: NOW_S - 60 * DAY_S }), 60 * DAY_S);
  put(plans, 'empty-handover.md', '', 60 * DAY_S);

  const res = maintenance.archiveStaleOpenHandovers(runs, NOW);
  expect(res).toEqual({ moved: 2, failed: [] });
  expect(fs.readdirSync(path.join(plans, '_archive')).sort()).toEqual(['hdr-old-handover.md', 'leg-old-handover.md']);
  for (const keep of ['hdr-edge-handover.md', 'leg-edge-handover.md', 'bad-handover.md', 'empty-handover.md']) {
    expect(fs.existsSync(path.join(plans, keep))).toBe(true);
  }
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveStaleOpenHandovers records stale-30d and archived epoch in header and appends ARCHIVED-STALE to legacy copy', () => {
  const { runs, plans } = mkPlans('maint-hv6-');
  put(plans, 'hdr-handover.md', openHdr(40 * DAY_S), 40 * DAY_S);
  put(plans, 'leg-handover.md', 'legacy body\n', 40 * DAY_S);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW).moved).toBe(2);

  const hdr = fs.readFileSync(path.join(plans, '_archive', 'hdr-handover.md'), 'utf8');
  expect(hdr).toContain('archive_reason: stale-30d');
  expect(hdr).toContain(`archived: ${NOW_S}`);
  expect(hdr).toContain('status: open');

  const leg = fs.readFileSync(path.join(plans, '_archive', 'leg-handover.md'), 'utf8');
  expect(leg.startsWith('legacy body\n')).toBe(true);
  expect(leg.trimEnd().split('\n').pop()).toBe('ARCHIVED-STALE: unresolved after 30 days (archived 2026-10-28)');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveStaleOpenHandovers never overwrites an existing archived name', () => {
  const { runs, plans } = mkPlans('maint-hv7-');
  fs.mkdirSync(path.join(plans, '_archive'));
  fs.writeFileSync(path.join(plans, '_archive', 'x-handover.md'), 'KEEP ME');
  put(plans, 'x-handover.md', 'stale legacy\n', 40 * DAY_S);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW).moved).toBe(1);
  expect(fs.readFileSync(path.join(plans, '_archive', 'x-handover.md'), 'utf8')).toBe('KEEP ME');
  expect(fs.readFileSync(path.join(plans, '_archive', 'x-handover.2.md'), 'utf8')).toContain('stale legacy');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveStaleOpenHandovers skips a file another session already moved and does not count it', () => {
  const { runs, plans } = mkPlans('maint-hv8-');
  put(plans, 'y-handover.md', 'stale legacy\n', 40 * DAY_S);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 1, failed: [] });
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 0, failed: [] });
  expect(fs.readdirSync(path.join(plans, '_archive'))).toEqual(['y-handover.md']);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archive dir that is a file reports failure and moves nothing', () => {
  const { runs, plans } = mkPlans('maint-hv9-');
  fs.writeFileSync(path.join(plans, '_archive'), 'i am a file');
  put(plans, 'z-handover.md', 'stale legacy\n', 40 * DAY_S);
  put(plans, 'zr-handover.md', 'FINAL OUTCOME: done\n', 5 * DAY_S);
  const res = maintenance.archiveStaleOpenHandovers(runs, NOW);
  expect(res.moved).toBe(0);
  expect(res.failed).toEqual([{ name: 'z-handover.md', code: 'ENOTDIR' }]);
  expect(maintenance.archiveResolvedHandovers(runs, NOW)).toEqual({ moved: 0, failed: [{ name: 'zr-handover.md', code: 'ENOTDIR' }] });
  expect(fs.existsSync(path.join(plans, 'z-handover.md'))).toBe(true);
  expect(fs.existsSync(path.join(plans, 'zr-handover.md'))).toBe(true);
  expect(fs.readFileSync(path.join(plans, '_archive'), 'utf8')).toBe('i am a file');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('scanHandovers returns openCount, staleCount (>7d), newestOpen, invalid reasons', () => {
  const { runs, plans } = mkPlans('maint-hv10-');
  put(plans, 'fresh-handover.md', openHdr(DAY_S), 0);
  put(plans, 'stale-handover.md', openHdr(10 * DAY_S), 0);
  put(plans, 'legacy-handover.md', 'legacy open\n', 20 * DAY_S);
  put(plans, 'done-handover.md', resolvedHdr(3600), 0);
  put(plans, 'bad-handover.md', headered({ status: 'open', created: 'abc' }), 0);
  put(plans, 'young-empty-handover.md', '', 10); // writer mid-create: silent
  put(plans, 'old-empty-handover.md', '', 120);

  const scan = maintenance.scanHandovers(runs, NOW);
  expect(scan.ok).toBe(true);
  expect(scan.error).toBeNull();
  expect(scan.items.length).toBe(7);
  expect(scan.openCount).toBe(3);
  expect(scan.staleCount).toBe(2);
  expect(scan.open.length).toBe(3);
  expect(scan.newestOpen.name).toBe('fresh-handover.md');
  expect([...scan.invalid].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: 'bad-handover.md', reason: 'bad-created' },
    { name: 'old-empty-handover.md', reason: 'empty' },
  ]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('scanHandovers reports error code for unreadable plans dir, silent for missing', () => {
  const runs = mkRuns('maint-hv11-');
  const missing = maintenance.scanHandovers(runs, NOW);
  expect(missing.ok).toBe(true);
  expect(missing.error).toBeNull();
  expect(missing.items).toEqual([]);

  fs.writeFileSync(path.join(runs, 'plans'), 'plans is a file');
  const broken = maintenance.scanHandovers(runs, NOW);
  expect(broken.ok).toBe(false);
  expect(broken.error).toBe('ENOTDIR');
  expect(broken.items).toEqual([]);
  expect(broken.openCount).toBe(0);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('scanItems caps at the newest 500 plus the oldest 500 names, deduped', () => {
  const { runs, plans } = mkPlans('maint-hv12-');
  const nm = (i) => `h${String(i).padStart(4, '0')}-handover.md`;
  for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(plans, nm(i)), 'open\n');
  const names = maintenance.scanHandovers(runs, NOW).items.map((h) => h.name);
  expect(names.length).toBe(1000);
  expect(names).toContain(nm(1099));
  expect(names).toContain(nm(0));
  expect(names).not.toContain(nm(500));
  fs.rmSync(runs, { recursive: true, force: true });
  const small = mkPlans('maint-hv12b-');
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(small.plans, nm(i)), 'open\n');
  expect(maintenance.scanHandovers(small.runs, NOW).items.length).toBe(600);
  fs.rmSync(small.runs, { recursive: true, force: true });
});

test('cleanupHandoverTemps removes .hv-tmp.* older than 60 min and keeps younger', () => {
  const { runs, plans } = mkPlans('maint-hv13-');
  put(plans, '.hv-tmp.1.old', 'x', 61 * 60);
  put(plans, '.hv-tmp.2.young', 'x', 59 * 60);
  put(plans, 'keep-handover.md', 'open\n', 5 * DAY_S);
  expect(maintenance.cleanupHandoverTemps(runs, NOW)).toBe(1);
  expect(fs.readdirSync(plans).sort()).toEqual(['.hv-tmp.2.young', 'keep-handover.md']);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('symlinked handover file is invalid symlink and not moved', () => {
  const { runs, plans } = mkPlans('maint-hv14-');
  const target = put(runs, 'outside.md', 'stale legacy\n', 40 * DAY_S);
  const link = path.join(plans, 'link-handover.md');
  fs.symlinkSync(target, link);
  const [h] = maintenance.listHandovers(runs, NOW);
  expect([h.name, h.status, h.valid, h.reason]).toEqual(['link-handover.md', 'invalid', false, 'symlink']);
  expect(maintenance.newestUnresolvedHandover(runs, NOW)).toBeNull();
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 0, failed: [] });
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(plans, '_archive', 'link-handover.md'))).toBe(false);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('uppercase HANDOVER filename is scanned', () => {
  const { runs, plans } = mkPlans('maint-hv15-');
  put(plans, 'X-HANDOVER.md', 'open\n', DAY_S);
  expect(maintenance.listHandovers(runs, NOW).map((h) => h.name)).toEqual(['X-HANDOVER.md']);
  expect(path.basename(maintenance.newestUnresolvedHandover(runs, NOW))).toBe('X-HANDOVER.md');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archiveStaleOpenHandovers age is max(created, mtime): an edited handover keeps its clock reset', () => {
  const { runs, plans } = mkPlans('maint-hv16-');
  put(plans, 'edited-handover.md', openHdr(31 * DAY_S), 0);
  put(plans, 'untouched-handover.md', openHdr(31 * DAY_S), 31 * DAY_S);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 1, failed: [] });
  expect(fs.existsSync(path.join(plans, 'edited-handover.md'))).toBe(true);
  expect(fs.existsSync(path.join(plans, '_archive', 'untouched-handover.md'))).toBe(true);
  // the 7d warning still uses created
  expect(maintenance.scanHandovers(runs, NOW).staleCount).toBe(1);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('symlinked plans dir: scan reports ELOOP, archivers and temp cleanup touch nothing', () => {
  const runs = mkRuns('maint-hv17-');
  const target = mkRuns('maint-hv17t-');
  put(target, 'stale-handover.md', 'stale legacy\n', 40 * DAY_S);
  put(target, 'res-handover.md', 'FINAL OUTCOME: done\n', 5 * DAY_S);
  put(target, '.hv-tmp.1.old', 'x', 2 * 3600);
  fs.symlinkSync(target, path.join(runs, 'plans'));
  const scan = maintenance.scanHandovers(runs, NOW);
  expect([scan.ok, scan.error, scan.items]).toEqual([false, 'ELOOP', []]);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 0, failed: [] });
  expect(maintenance.archiveResolvedHandovers(runs, NOW)).toEqual({ moved: 0, failed: [] });
  expect(maintenance.cleanupHandoverTemps(runs, NOW)).toBe(0);
  expect(fs.readdirSync(target).sort()).toEqual(['.hv-tmp.1.old', 'res-handover.md', 'stale-handover.md']);
  fs.rmSync(runs, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('archiveResolvedHandovers reports failures when _archive is a file', () => {
  const { runs, plans } = mkPlans('maint-hv18-');
  fs.writeFileSync(path.join(plans, '_archive'), 'i am a file');
  put(plans, 'r-handover.md', resolvedHdr(2 * DAY_S), 0);
  const res = maintenance.archiveResolvedHandovers(runs, NOW);
  expect(res.moved).toBe(0);
  expect(res.failed).toEqual([{ name: 'r-handover.md', code: 'ENOTDIR' }]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('archivers and scanHandovers use pre-scanned items when given', () => {
  const { runs, plans } = mkPlans('maint-hv19-');
  put(plans, 'old-handover.md', 'stale legacy\n', 40 * DAY_S);
  put(plans, 'res-handover.md', resolvedHdr(2 * DAY_S), 0);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW, { items: [] })).toEqual({ moved: 0, failed: [] });
  expect(maintenance.archiveResolvedHandovers(runs, NOW, { items: [] })).toEqual({ moved: 0, failed: [] });
  expect(maintenance.scanHandovers(runs, NOW, { items: [] }).items).toEqual([]);
  const { items } = maintenance.scanItems(runs, NOW);
  expect(maintenance.scanHandovers(runs, NOW, { items }).openCount).toBe(1);
  expect(maintenance.archiveResolvedHandovers(runs, NOW, { items }).moved).toBe(1);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW, { items }).moved).toBe(1);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('cleanupHandoverTemps also clears old .hv-tmp.* in _archive, keeps young tmp and empty reservations', () => {
  const { runs, plans } = mkPlans('maint-hv20-');
  const arch = path.join(plans, '_archive');
  fs.mkdirSync(arch);
  put(arch, '.hv-tmp.1.old', 'x', 61 * 60);
  put(arch, '.hv-tmp.2.young', 'x', 59 * 60);
  put(arch, 'x-handover.md', '', 5 * 3600);
  expect(maintenance.cleanupHandoverTemps(runs, NOW)).toBe(1);
  expect(fs.readdirSync(arch).sort()).toEqual(['.hv-tmp.2.young', 'x-handover.md']);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('cleanupHandoverTemps skips a symlinked _archive', () => {
  const { runs, plans } = mkPlans('maint-hv21-');
  const target = mkRuns('maint-hv21t-');
  put(target, '.hv-tmp.1.old', 'x', 2 * 3600);
  fs.symlinkSync(target, path.join(plans, '_archive'));
  expect(maintenance.cleanupHandoverTemps(runs, NOW)).toBe(0);
  expect(fs.readdirSync(target)).toEqual(['.hv-tmp.1.old']);
  fs.rmSync(runs, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('scanHandovers staleCount boundary: exactly 7d is not stale, 7d+1s is', () => {
  const { runs, plans } = mkPlans('maint-hv22-');
  put(plans, 'a-handover.md', openHdr(604800), 0);
  expect(maintenance.scanHandovers(runs, NOW).staleCount).toBe(0);
  put(plans, 'b-handover.md', openHdr(604801), 0);
  expect(maintenance.scanHandovers(runs, NOW).staleCount).toBe(1);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('legacy file with mtime +365d has createdMs <= now (clamped)', () => {
  const { runs, plans } = mkPlans('maint-hv23-');
  put(plans, 'f-handover.md', 'legacy open\n', -365 * DAY_S);
  const [h] = maintenance.listHandovers(runs, NOW);
  expect(h.createdMs).toBeLessThanOrEqual(NOW);
  expect(h.mtime).toBeLessThanOrEqual(NOW);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('headered open file, created 40d ago, mtime +1d: kept today, archived once now passes mtime + 30d', () => {
  const { runs, plans } = mkPlans('maint-hv24-');
  put(plans, 'f-handover.md', openHdr(40 * DAY_S), -DAY_S);
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 0, failed: [] });
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW + 32 * DAY_S * 1000)).toEqual({ moved: 1, failed: [] });
  expect(fs.existsSync(path.join(plans, '_archive', 'f-handover.md'))).toBe(true);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('legacy resolved file with a future mtime (+1h) is archived once now passes mtime + 24h', () => {
  const { runs, plans } = mkPlans('maint-hv25-');
  put(plans, 'r-handover.md', 'FINAL OUTCOME: done\n', -3600);
  expect(maintenance.archiveResolvedHandovers(runs, NOW)).toEqual({ moved: 0, failed: [] });
  expect(maintenance.archiveResolvedHandovers(runs, NOW + 26 * 3_600_000)).toEqual({ moved: 1, failed: [] });
  fs.rmSync(runs, { recursive: true, force: true });
});

test('headered resolved file without a resolved epoch and a future mtime falls back to clamped mtime', () => {
  const { runs, plans } = mkPlans('maint-hv26-');
  const c = headered({ status: 'resolved', created: NOW_S - 90 * DAY_S, sid: 's1' });
  put(plans, 'r-handover.md', c, -3600);
  expect(maintenance.listHandovers(runs, NOW)[0].resolvedMs).toBeLessThanOrEqual(NOW);
  expect(maintenance.archiveResolvedHandovers(runs, NOW).moved).toBe(0);
  expect(maintenance.archiveResolvedHandovers(runs, NOW + 26 * 3_600_000).moved).toBe(1);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('isArchiveDue boundaries: resolved at 24h, open at 30d', () => {
  const due = maintenance.isArchiveDue;
  const H = 1000;
  const res = (agoS) => ({ status: 'resolved', resolvedMs: NOW - agoS * H, createdMs: 0, mtime: 0 });
  expect(due(res(86_400), NOW)).toBe(false);
  expect(due(res(86_401), NOW)).toBe(true);
  const open = (agoS) => ({ status: 'open', createdMs: NOW - agoS * H, mtime: NOW - agoS * H });
  expect(due(open(2_592_000), NOW)).toBe(false);
  expect(due(open(2_592_001), NOW)).toBe(true);
  expect(due({ status: 'open', createdMs: NOW - 40 * DAY_S * H, mtime: NOW + 365 * DAY_S * H }, NOW)).toBe(false);
  expect(due({ status: 'open', createdMs: NOW - 40 * DAY_S * H, mtime: NOW + DAY_S * H }, NOW + 32 * DAY_S * H)).toBe(true);
  expect(due({ status: 'invalid', createdMs: 0, mtime: 0 }, NOW)).toBe(false);
});

test('600 entries: archiver drains the oldest 100 stale-open; newestUnresolvedHandover still returns the newest', () => {
  const { runs, plans } = mkPlans('maint-hv27-');
  const nm = (i) => `h${String(i).padStart(3, '0')}-handover.md`;
  for (let i = 0; i < 600; i++) put(plans, nm(i), i < 100 ? openHdr(40 * DAY_S) : openHdr(DAY_S), i < 100 ? 40 * DAY_S : DAY_S);
  expect(maintenance.newestUnresolvedHandover(runs, NOW)).toBe(path.join(plans, nm(599)));
  expect(maintenance.archiveStaleOpenHandovers(runs, NOW)).toEqual({ moved: 100, failed: [] });
  expect(fs.existsSync(path.join(plans, '_archive', nm(0)))).toBe(true);
  expect(fs.existsSync(path.join(plans, nm(100)))).toBe(true);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('runHandoverMaintenance: a file another session archives between scan and archive is not reported', async () => {
  const { runs, plans } = mkPlans('maint-hv28-');
  const H = await import('../lib/handover.js');
  const p = put(plans, 'w-handover.md', '# t\n\nopen legacy body\n', 40 * DAY_S);
  const r = maintenance.runHandoverMaintenance(runs, NOW, {
    beforeArchive: () => { expect(H.moveToArchive(p, path.join(plans, '_archive'), null, null).ok).toBe(true); },
  });
  expect(r.stale.moved).toBe(0);
  expect(r.scan.openCount).toBe(0);
  expect(r.scan.newestOpen).toBeNull();
  fs.rmSync(runs, { recursive: true, force: true });
});

test('runHandoverMaintenance: nothing due returns the plain scan', () => {
  const { runs, plans } = mkPlans('maint-hv29-');
  put(plans, 'a-handover.md', openHdr(DAY_S), DAY_S);
  put(plans, 'b-handover.md', resolvedHdr(3600), 0);
  const r = maintenance.runHandoverMaintenance(runs, NOW);
  expect(r.scan).toEqual(maintenance.scanHandovers(runs, NOW));
  expect([r.resolved.moved, r.stale.moved]).toEqual([0, 0]);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('runHandoverMaintenance: one stale file is archived and the scan no longer lists it', () => {
  const { runs, plans } = mkPlans('maint-hv30-');
  put(plans, 's-handover.md', '# t\n\nopen legacy body\n', 40 * DAY_S);
  const r = maintenance.runHandoverMaintenance(runs, NOW);
  expect(r.stale.moved).toBe(1);
  expect(r.scan.openCount).toBe(0);
  expect(fs.existsSync(path.join(plans, '_archive', 's-handover.md'))).toBe(true);
  fs.rmSync(runs, { recursive: true, force: true });
});
