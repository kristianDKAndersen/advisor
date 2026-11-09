'use strict';
// Lesson lifecycle operations. Every mutator is dry-run capable and none deletes a file.
const fs = require('fs');
const path = require('path');
const vault = require('./vault');
const { lessonStats } = require('./recall-telemetry');

const AUDIENCES = ['advisor', 'worker', 'both'];
const WINDOW_DAYS = 90;
const DAY_MS = 86400000;
const DEFAULT_DOCTRINE = path.join(__dirname, '..', 'claude.md');

const oneLine = s => String(s == null ? '' : s).replace(/\s*[\r\n]+\s*/g, ' ').trim();

function lessonsDir() { return path.join(fs.realpathSync(vault.vaultRoot()), 'lessons'); }

// Accepts a basename or a lessons/... path; the real path must stay inside <vault>/lessons/.
function resolveLessonRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('resolveLessonRef: empty lesson ref');
  if (ref.split(/[\\/]/).includes('..')) throw new Error(`resolveLessonRef: '..' not allowed: ${ref}`);
  const root = fs.realpathSync(vault.vaultRoot());
  const dir = lessonsDir();
  let candidate;
  if (path.isAbsolute(ref)) candidate = ref;
  else if (!ref.includes('/') && !ref.includes('\\')) candidate = path.join(dir, ref);
  else if (ref.startsWith('lessons/')) candidate = path.join(root, ref);
  else throw new Error(`resolveLessonRef: not a lesson path: ${ref}`);
  let real;
  try { real = fs.realpathSync(candidate); } catch (_) { throw new Error(`resolveLessonRef: lesson not found: ${ref}`); }
  if (!real.startsWith(dir + path.sep)) throw new Error(`resolveLessonRef: outside the lessons directory: ${ref}`);
  return { rel: path.relative(root, real).split(path.sep).join('/'), abs: real };
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, `${base}/${e.name}`, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(`${base}/${e.name}`);
  }
  return out;
}

function allLessons() {
  const rows = [];
  for (const rel of walk(path.join(vault.vaultRoot(), 'lessons'), 'lessons', [])) {
    const note = vault.readNote(rel);
    if (note && note.fm.type === 'lesson') rows.push({ rel, fm: note.fm, body: note.body });
  }
  return rows;
}

function listLessons({ status, audience } = {}) {
  return allLessons()
    .map(l => ({ path: l.rel, status: l.fm.status || '', audience: l.fm.audience || 'both', created_at: l.fm.created_at || '', reviewed_at: l.fm.reviewed_at || '', promoted_to: l.fm.promoted_to || '' }))
    .filter(l => (status === undefined || l.status === status) && (audience === undefined || l.audience === audience));
}

function readDoctrine(doctrinePath) {
  try { return fs.readFileSync(doctrinePath || DEFAULT_DOCTRINE, 'utf8'); } catch (_) { return null; }
}

function reviewQueue({ now = Date.now(), doctrinePath } = {}) {
  const queue = [];
  const add = (l, reason) => queue.push({ path: l.rel, reason });
  const lessons = allLessons();
  const stats = lessonStats({ now: now / 1000 }).lessons;
  const cutoffMs = now - WINDOW_DAYS * DAY_MS;
  let flagged = new Set();
  try {
    flagged = new Set(vault.scanStale({ dryRun: true }).report.filter(r => r.action === 'flag-lesson').map(r => r.path));
  } catch (_) { /* index unavailable: skip the scan-stale reason */ }
  const doctrine = lessons.some(l => l.fm.status === 'promoted') ? readDoctrine(doctrinePath) : null;
  for (const l of lessons) {
    const status = l.fm.status || '';
    if (status === 'proposed') add(l, 'proposed');
    if (status === 'archived') add(l, 'legacy-archived');
    if (status === 'active') {
      const base = Math.max(Date.parse(l.fm.created_at) || 0, Date.parse(l.fm.reviewed_at) || 0);
      const s = stats[l.rel];
      if (base && base <= cutoffMs && !(s && s.last_recalled * 1000 >= cutoffMs)) add(l, 'zero-recall-90d');
      if (!l.fm.audience) add(l, 'audience-missing');
    }
    if (flagged.has(l.rel)) add(l, 'scan-stale');
    if (status === 'promoted' && !(doctrine !== null && l.fm.promoted_to && doctrine.includes(l.fm.promoted_to))) add(l, 'anchor-missing');
  }
  return queue;
}

function heuristicText(body) {
  const m = /^## Heuristic[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  return m ? m[1].trim() : '';
}

function checkAudience(a) {
  if (!AUDIENCES.includes(a)) throw new Error(`audience must be one of ${AUDIENCES.join(', ')}`);
}

// Runs plan(note) under the note lock; it returns the new frontmatter fields, or null for a no-op.
function mutate(rel, dryRun, plan) {
  return vault.withNoteLock(rel, () => {
    const note = vault.readNote(rel);
    if (!note) return { changed: [], dryRun };
    const set = plan(note);
    if (!set) return { changed: [], dryRun };
    if (!dryRun) vault.writeNote(rel, { ...note.fm, ...set }, note.body);
    return { changed: [{ path: rel, set }], dryRun };
  });
}

function approveLesson(ref, { dryRun = false, audience } = {}) {
  const { rel } = resolveLessonRef(ref);
  return mutate(rel, dryRun, ({ fm, body }) => {
    const status = fm.status || '';
    if (status === 'promoted' || status === 'retired') throw new Error(`approveLesson: cannot approve a ${status} lesson`);
    if (status === 'active') return null;
    if (!heuristicText(body)) throw new Error('approveLesson: empty "## Heuristic" section');
    if (audience !== undefined) checkAudience(audience);
    const aud = audience || fm.audience;
    if (!aud) throw new Error('approveLesson: audience required (advisor | worker | both)');
    checkAudience(aud);
    return { status: 'active', audience: aud };
  });
}

function setAudience(ref, { audience, dryRun = false } = {}) {
  checkAudience(audience);
  const { rel } = resolveLessonRef(ref);
  return mutate(rel, dryRun, () => ({ audience }));
}

function promoteLesson(ref, { to, dryRun = false, doctrinePath } = {}) {
  const anchor = oneLine(to);
  if (!anchor) throw new Error('promoteLesson: "to" is required');
  const doctrine = readDoctrine(doctrinePath);
  if (doctrine === null || !doctrine.includes(anchor)) throw new Error('promoteLesson: anchor text not found in the doctrine file');
  const { rel } = resolveLessonRef(ref);
  return mutate(rel, dryRun, () => ({ status: 'promoted', promoted_to: anchor }));
}

function keepLesson(ref, { dryRun = false } = {}) {
  const { rel } = resolveLessonRef(ref);
  return mutate(rel, dryRun, () => ({ reviewed_at: new Date().toISOString() }));
}

function retireLesson(ref, { reason = '', dryRun = false } = {}) {
  let rel;
  try { rel = resolveLessonRef(ref).rel; } catch (err) {
    // A finished earlier retire leaves the note only under lessons/archive/.
    const base = path.basename(String(ref));
    const arch = `lessons/archive/${base}`;
    const done = vault.readNote(arch);
    if (!path.isAbsolute(String(ref)) && !String(ref).includes('..') && done && done.fm.status === 'retired') return { changed: [], dryRun };
    throw err;
  }
  const dest = `lessons/archive/${path.basename(rel)}`;
  const needsMove = path.posix.dirname(rel) === 'lessons';
  const res = mutate(rel, dryRun, ({ fm }) => (fm.status === 'retired' && !needsMove ? null : (fm.status === 'retired'
    ? {}
    : { status: 'retired', retired_at: new Date().toISOString(), retired_reason: oneLine(reason) })));
  if (!res.changed.length) return res;
  if (needsMove) res.changed[0].moved_to = dest;
  if (dryRun || !needsMove) return res;
  // moveNote takes the same lock, so it must run after mutate releases it.
  try { vault.moveNote(rel, dest); } catch (err) {
    if (!fs.existsSync(path.join(vault.vaultRoot(), rel))) return { changed: [], dryRun };
    throw err;
  }
  return res;
}

module.exports = { AUDIENCES, listLessons, reviewQueue, approveLesson, setAudience, promoteLesson, retireLesson, keepLesson, resolveLessonRef };
