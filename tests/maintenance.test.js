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

  const moved = maintenance.archiveResolvedHandovers(runs);
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
