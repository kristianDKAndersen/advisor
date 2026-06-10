// lib/maintenance.js — testable selection + archiving logic for the SessionStart
// hook (.claude/hooks/session-start.js). CommonJS, Node-safe (only fs + path),
// so the node-interpreted hook can require it directly. The reminder archiver
// takes the vault module as a parameter (dependency injection) instead of
// requiring lib/vault.js, because vault.js loads bun:sqlite at module top and
// would throw under node — the hook invokes archiveStaleReminders via `bun -e`.
//
// Every function is bounded and defensive: filesystem errors degrade to a
// no-op (empty list / null / 0 moved) so the hook never throws or blocks.

const fs = require('fs');
const path = require('path');

const RESOLVED_RE = /FINAL OUTCOME/i; // established convention: a resolved handover
const DAY_MS = 86_400_000;

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
// 'handover' (case-insensitive). Excludes the _archive/ subdir. Returns
// [{ path, name, mtime, resolved }]. A handover is resolved iff RESOLVED_RE matches.
function listHandovers(runsRoot) {
  const plansDir = path.join(runsRoot, 'plans');
  let names;
  try { names = fs.readdirSync(plansDir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (name === '_archive') continue;
    if (!/handover/i.test(name)) continue;
    const abs = path.join(plansDir, name);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      const content = fs.readFileSync(abs, 'utf8');
      out.push({ path: abs, name, mtime: st.mtimeMs, resolved: RESOLVED_RE.test(content) });
    } catch (_) { /* unreadable — skip */ }
  }
  return out;
}

// (B) Absolute path of the single newest UNRESOLVED handover, or null.
function newestUnresolvedHandover(runsRoot) {
  const unresolved = listHandovers(runsRoot).filter((h) => !h.resolved);
  if (!unresolved.length) return null;
  unresolved.sort((a, b) => b.mtime - a.mtime);
  return unresolved[0].path;
}

// (C) Move resolved handovers older than 24h into runs/plans/_archive/. The 24h
// floor keeps a freshly-resolved handover visible for at least one more session.
// Returns the number of files moved.
function archiveResolvedHandovers(runsRoot, now = Date.now()) {
  const archiveDir = path.join(runsRoot, 'plans', '_archive');
  let moved = 0;
  for (const h of listHandovers(runsRoot)) {
    if (!h.resolved) continue;
    if (now - h.mtime <= DAY_MS) continue;
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(h.path, path.join(archiveDir, h.name));
      moved++;
    } catch (_) { /* skip this one on any error */ }
  }
  return moved;
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
  archiveStaleReminders,
};
