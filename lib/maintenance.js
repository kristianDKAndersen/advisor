// lib/maintenance.js — testable selection + archiving logic for the SessionStart
// hook (.claude/hooks/session-start.js). CommonJS, Node-safe (only fs + path +
// lib/handover.js), so the node-interpreted hook can require it directly. The
// reminder archiver takes the vault module as a parameter (dependency injection)
// instead of requiring lib/vault.js, because vault.js loads bun:sqlite at module
// top and would throw under node — the hook invokes archiveStaleReminders via `bun -e`.
//
// Every function is bounded and defensive: filesystem errors degrade to a
// no-op (empty list / null / 0 moved) so the hook never throws or blocks.

const fs = require('fs');
const path = require('path');
const H = require('./handover');

const RESOLVED_RE = H.LEGACY_RESOLVED_RE; // anchored legacy rule; headered files use `status:`
const DAY_MS = 86_400_000;
const SCAN_CAP = 500;
const TMP_MAX_AGE_MS = 3_600_000;

// (A) Newest run dir with a readable, valid session.json. Entries are sorted by
// mtime desc; 'plans' and '_archive' siblings and any dir lacking a parseable
// session.json are skipped. Returns { sid, session } or null if none qualify.
function pickLastSession(runsRoot) {
  let names;
  try { names = fs.readdirSync(runsRoot); } catch (_) { return null; }
  const entries = [];
  for (const name of names) {
    if (name === 'plans' || name === '_archive') continue;
    try {
      const st = fs.statSync(path.join(runsRoot, name));
      if (!st.isDirectory()) continue;
      entries.push({ sid: name, mtime: st.mtimeMs });
    } catch (_) { /* unreadable entry — skip */ }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const e of entries) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(runsRoot, e.sid, 'session.json'), 'utf8'));
      return { sid: e.sid, session: s };
    } catch (_) { /* missing/unreadable/invalid session.json — skip */ }
  }
  return null;
}

// Top-level (non-recursive) scan of runs/plans/ for files whose name contains
// 'handover' (case-insensitive), capped at SCAN_CAP entries. Excludes the _archive/
// subdir and any directory. Returns { error, items }; `error` is an errno code
// string when plans/ cannot be read for a reason other than ENOENT. Each item:
// { path, name, mtime, resolved, status: 'open'|'resolved'|'invalid', kind, valid,
// createdMs, resolvedMs, reason }. Reads never follow symlinks (see readHandover).
function scanItems(runsRoot, now) {
  const plansDir = path.join(runsRoot, 'plans');
  let ents;
  try { ents = fs.readdirSync(plansDir, { withFileTypes: true }); } catch (e) {
    return { error: e.code === 'ENOENT' ? null : (e.code || 'EIO'), items: [] };
  }
  const names = ents
    .filter((d) => !d.isDirectory() && /handover/i.test(d.name) && !d.name.startsWith(H.TMP_PREFIX))
    .map((d) => d.name)
    .sort()
    .slice(0, SCAN_CAP);
  const items = names.map((name) => {
    const abs = path.join(plansDir, name);
    const h = H.readHandover(abs, now);
    const valid = h.kind === 'header' || h.kind === 'legacy';
    const status = valid ? h.status : 'invalid';
    return {
      path: abs, name, mtime: h.mtimeMs || 0, resolved: status === 'resolved', status,
      kind: h.kind, valid, createdMs: h.createdMs, resolvedMs: h.resolvedMs, reason: h.reason,
    };
  });
  return { error: null, items };
}

function listHandovers(runsRoot, now = Date.now()) {
  return scanItems(runsRoot, now).items;
}

// Single pass: open (newest first), stale-open count (>7d), newest open, and
// invalid entries. An empty file younger than the grace period is a writer
// mid-create and is not reported.
function scanHandovers(runsRoot, now = Date.now()) {
  const { error, items } = scanItems(runsRoot, now);
  const open = items
    .filter((h) => h.status === 'open')
    .sort((a, b) => b.createdMs - a.createdMs || (a.name < b.name ? 1 : -1));
  const invalid = items
    .filter((h) => h.status === 'invalid' && !(h.kind === 'empty' && now - h.mtime < H.EMPTY_GRACE_S * 1000))
    .map((h) => ({ name: h.name, reason: h.reason }));
  return {
    ok: error === null, error, items, open,
    openCount: open.length,
    staleCount: open.filter((h) => now - h.createdMs > H.STALE_WARN_S * 1000).length,
    newestOpen: open[0] || null,
    invalid,
  };
}

// (B) Absolute path of the single newest UNRESOLVED handover, or null.
function newestUnresolvedHandover(runsRoot, now = Date.now()) {
  const top = scanHandovers(runsRoot, now).newestOpen;
  return top ? top.path : null;
}

// (C) Move resolved handovers older than 24h into runs/plans/_archive/. The 24h
// floor keeps a freshly-resolved handover visible for at least one more session.
// Age is the header `resolved` epoch (legacy: mtime). Returns the number moved.
function archiveResolvedHandovers(runsRoot, now = Date.now()) {
  const archiveDir = path.join(runsRoot, 'plans', '_archive');
  let moved = 0;
  for (const h of listHandovers(runsRoot, now)) {
    if (h.status !== 'resolved' || now - h.resolvedMs <= H.RESOLVED_ARCHIVE_S * 1000) continue;
    const updates = h.kind === 'header' ? { archived: Math.floor(now / 1000), archive_reason: 'resolved-24h' } : null;
    if (H.moveToArchive(h.path, archiveDir, updates, null).ok) moved++;
  }
  return moved;
}

// (C2) Move open handovers older than 30d (header `created`, legacy mtime) into
// _archive/. Invalid, unreadable and empty files are never moved. A file another
// session already moved (ENOENT) is skipped, not counted. Returns { moved, failed }.
function archiveStaleOpenHandovers(runsRoot, now = Date.now()) {
  const archiveDir = path.join(runsRoot, 'plans', '_archive');
  let moved = 0;
  const failed = [];
  for (const h of listHandovers(runsRoot, now)) {
    if (h.status !== 'open' || now - h.createdMs <= H.STALE_OPEN_S * 1000) continue;
    const r = h.kind === 'header'
      ? H.moveToArchive(h.path, archiveDir, { archived: Math.floor(now / 1000), archive_reason: 'stale-30d' }, null)
      : H.moveToArchive(h.path, archiveDir, null, `ARCHIVED-STALE: unresolved after 30 days (archived ${new Date(now).toISOString().slice(0, 10)})`);
    if (r.ok) moved++;
    else if (!r.skipped) failed.push({ name: h.name, code: r.code });
  }
  return { moved, failed };
}

// Remove orphan `.hv-tmp.*` files (killed writers) older than 60 min. Returns the count removed.
function cleanupHandoverTemps(runsRoot, now = Date.now()) {
  const plansDir = path.join(runsRoot, 'plans');
  let names;
  try { names = fs.readdirSync(plansDir); } catch (_) { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(H.TMP_PREFIX)) continue;
    const abs = path.join(plansDir, name);
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || now - st.mtimeMs <= TMP_MAX_AGE_MS) continue;
      fs.unlinkSync(abs);
      removed++;
    } catch (_) { /* gone or unreadable — skip */ }
  }
  return removed;
}

// (D) Archive vault reminders due more than `maxAgeDays` (default 30) before
// `today`. This is a STATUS change (vault.setStatus → 'archived'), not a file
// move: reminder notes are FTS-indexed, and setStatus updates both the file
// frontmatter AND the index row, so the note disappears from listDue. Candidates
// come from vault.listDue(today, 0) (due_date <= today, already excluding
// dismissed statuses). Returns the number of reminders archived.
function archiveStaleReminders(vault, today = new Date().toISOString().slice(0, 10), maxAgeDays = 30) {
  const [y, m, d] = today.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d) - maxAgeDays * DAY_MS).toISOString().slice(0, 10);
  let candidates;
  try { candidates = vault.listDue(today, 0); } catch (_) { return 0; }
  let archived = 0;
  for (const note of candidates) {
    if (!note.due_date || note.due_date >= cutoff) continue; // not more than maxAgeDays past due
    try { vault.setStatus(note.path, 'archived'); archived++; } catch (_) { /* skip on error */ }
  }
  return archived;
}

module.exports = {
  RESOLVED_RE,
  pickLastSession,
  listHandovers,
  newestUnresolvedHandover,
  archiveResolvedHandovers,
  archiveStaleOpenHandovers,
  scanHandovers,
  cleanupHandoverTemps,
  archiveStaleReminders,
};
