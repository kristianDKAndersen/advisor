// lib/handover.js — shared handover-file module (header parser, legacy rule, header rewrite,
// atomic file helpers). CommonJS, Node-safe (fs + path only): the node SessionStart hook loads it.
// Atomic writes use open(wx) + same-dir tmp + rename, never link() (fails on exFAT/SMB).
// Reads never follow symlinks.

const fs = require('fs');
const path = require('path');

const HEADER_KEYS = ['status', 'created', 'sid', 'resolved', 'outcome', 'archived', 'archive_reason'];
const LEGACY_RESOLVED_RE = /^(?:#{1,6}[ \t]+)?FINAL OUTCOME\b/im;
const MAX_BYTES = 1048576;
const STALE_OPEN_S = 2592000;
const STALE_WARN_S = 604800;
const RESOLVED_ARCHIVE_S = 86400;
const EMPTY_GRACE_S = 60;
const TMP_PREFIX = '.hv-tmp.';
const FUTURE_SKEW_S = 300;
const HEADER_MAX_LINES = 40;
const KEY_RE = /^([a-z_]+):(.*)$/;
const FENCE_RE = /^---[ \t]*$/;

// Single-line, capped value; `sid` is further restricted to [A-Za-z0-9._-].
function cleanValue(key, v) {
  let s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  if (key === 'sid') return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return s.slice(0, 200).trim();
}

function headerLine(key, v) {
  const s = cleanValue(key, v);
  return s ? `${key}: ${s}` : `${key}:`;
}

function renderHeader(fields = {}) {
  return `---\n${HEADER_KEYS.map((k) => headerLine(k, fields[k])).join('\n')}\n---\n`;
}

function classifyContent(content, { mtimeMs = 0, nowMs = Date.now() } = {}) {
  const base = { kind: 'invalid', status: null, createdMs: null, resolvedMs: null, sid: '', outcome: '', reason: null };
  let text = String(content);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { ...base, kind: 'empty', reason: 'empty' };
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (!FENCE_RE.test(lines[0])) {
    const resolved = LEGACY_RESOLVED_RE.test(text);
    return { ...base, kind: 'legacy', status: resolved ? 'resolved' : 'open', createdMs: mtimeMs, resolvedMs: resolved ? mtimeMs : null };
  }
  const rel = lines.slice(1, HEADER_MAX_LINES).findIndex((l) => FENCE_RE.test(l));
  if (rel < 0) return { ...base, reason: 'unclosed-header' };
  const f = new Map();
  for (let i = 1; i <= rel; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (m && !f.has(m[1])) f.set(m[1], m[2].replace(/^ /, '').replace(/ +$/, ''));
  }
  const status = f.get('status');
  if (status !== 'open' && status !== 'resolved') return { ...base, reason: 'bad-status' };
  const created = f.get('created');
  if (!/^[0-9]{1,12}$/.test(created || '')) return { ...base, reason: 'bad-created' };
  if (Number(created) * 1000 > nowMs + FUTURE_SKEW_S * 1000) return { ...base, reason: 'future-created' };
  const resolved = f.get('resolved');
  const resolvedMs = status === 'resolved' ? (/^[0-9]{1,12}$/.test(resolved || '') ? Number(resolved) * 1000 : mtimeMs) : null;
  return { ...base, kind: 'header', status, createdMs: Number(created) * 1000, resolvedMs, sid: f.get('sid') || '', outcome: f.get('outcome') || '' };
}

// lstat + O_NOFOLLOW open: a symlink is reported, never followed.
function readHandover(absPath, nowMs = Date.now()) {
  const fail = (kind, reason, mtimeMs) => ({ kind, status: null, createdMs: null, resolvedMs: null, sid: '', outcome: '', reason, mtimeMs });
  let st;
  try { st = fs.lstatSync(absPath); } catch (e) { return fail('unreadable', `unreadable:${e.code || 'EIO'}`); }
  if (st.isSymbolicLink()) return fail('invalid', 'symlink', st.mtimeMs);
  if (!st.isFile()) return fail('unreadable', `unreadable:${st.isDirectory() ? 'EISDIR' : 'EINVAL'}`, st.mtimeMs);
  if (st.size > MAX_BYTES) return fail('invalid', 'too-large', st.mtimeMs);
  let content;
  let fd;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    content = fs.readFileSync(fd, 'utf8');
  } catch (e) {
    if (e.code === 'ELOOP') return fail('invalid', 'symlink', st.mtimeMs);
    return fail('unreadable', `unreadable:${e.code || 'EIO'}`, st.mtimeMs);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* already closed */ }
  }
  return { ...classifyContent(content, { mtimeMs: st.mtimeMs, nowMs }), mtimeMs: st.mtimeMs };
}

// Rewrite only the named header keys; the body is returned byte-for-byte.
// A named key that is absent is inserted before the closing `---`.
function applyHeaderUpdates(content, updates) {
  const bom = content.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const lines = content.slice(bom.length).split('\n');
  const strip = (l) => l.replace(/\r$/, '');
  const rel = FENCE_RE.test(strip(lines[0])) ? lines.slice(1, HEADER_MAX_LINES).findIndex((l) => FENCE_RE.test(strip(l))) : -1;
  if (rel < 0) throw new Error('applyHeaderUpdates: no closed header');
  const end = rel + 1;
  const seen = new Set();
  for (let i = 1; i < end; i++) {
    const m = KEY_RE.exec(strip(lines[i]));
    if (!m || seen.has(m[1]) || !Object.prototype.hasOwnProperty.call(updates, m[1])) continue;
    seen.add(m[1]);
    lines[i] = headerLine(m[1], updates[m[1]]) + (lines[i].endsWith('\r') ? '\r' : '');
  }
  const missing = Object.keys(updates).filter((k) => !seen.has(k) && HEADER_KEYS.includes(k));
  lines.splice(end, 0, ...missing.map((k) => headerLine(k, updates[k])));
  return bom + lines.join('\n');
}

function tmpPath(dir) {
  return path.join(dir, `${TMP_PREFIX}${process.pid}.${Math.random().toString(36).slice(2, 10)}`);
}

// Write full content to a same-dir tmp (wx) then rename over the target.
// `beforeRename` runs after the tmp is written; if it throws, the tmp is removed
// and the target is left untouched.
function atomicReplace(targetAbs, content, mode, beforeRename) {
  const tmp = tmpPath(path.dirname(targetAbs));
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    if (mode != null) fs.chmodSync(tmp, mode & 0o7777);
    if (beforeRename) beforeRename();
    fs.renameSync(tmp, targetAbs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* tmp never created or already gone */ }
    throw e;
  }
}

// Claim the first free name via open(wx), then swap the full content onto our
// own empty reservation. nameFn(n) is called with n = 1, 2, ... (max 99).
function createExclusive(dir, nameFn, content) {
  for (let n = 1; n <= 99; n++) {
    const name = nameFn(n);
    const p = path.join(dir, name);
    try { fs.closeSync(fs.openSync(p, 'wx')); } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try { atomicReplace(p, content); } catch (e) {
      try { fs.rmSync(p, { force: true }); } catch (_) { /* reservation already gone */ }
      throw e;
    }
    return name;
  }
  throw Object.assign(new Error('no free handover name'), { code: 'EEXHAUST' });
}

// Move srcAbs into archiveDir without overwriting: reserve the destination with
// open(wx), suffix .2, .3 ... before the extension on EEXIST. ENOENT on rename
// means another session moved it first (skipped, not an error). After the move
// the archived copy gets `updates` (header keys) and/or `legacyNote` (appended line).
function moveToArchive(srcAbs, archiveDir, updates, legacyNote) {
  try {
    let lst = null;
    try { lst = fs.lstatSync(archiveDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!lst) fs.mkdirSync(archiveDir, { recursive: true });
    else if (!lst.isDirectory()) return { ok: false, code: lst.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR' };
  } catch (e) { return { ok: false, code: e.code || 'EIO' }; }
  const base = path.basename(srcAbs);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dest = null;
  for (let n = 1; n <= 99 && !dest; n++) {
    const cand = path.join(archiveDir, n === 1 ? base : `${stem}.${n}${ext}`);
    try { fs.closeSync(fs.openSync(cand, 'wx')); dest = cand; } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, code: e.code || 'EIO' };
    }
  }
  if (!dest) return { ok: false, code: 'EEXHAUST' };
  try { fs.renameSync(srcAbs, dest); } catch (e) {
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* reservation already gone */ }
    return e.code === 'ENOENT' ? { ok: false, code: 'ENOENT', skipped: true } : { ok: false, code: e.code || 'EIO' };
  }
  if (updates || legacyNote) {
    try {
      let c = fs.readFileSync(dest, 'utf8');
      if (updates) c = applyHeaderUpdates(c, updates);
      if (legacyNote) c += `${c.endsWith('\n') ? '' : '\n'}${legacyNote}\n`;
      atomicReplace(dest, c);
    } catch (_) { /* moved already; the archive note is best-effort */ }
  }
  return { ok: true, dest };
}

// Resolve one handover file. Returns { code, message }: 0 ok, 1 IO, 2 usage /
// not a handover / invalid or unreadable, 3 symlink (file or plans dir) refused, 4 already resolved or changed.
// opts.beforeRename is a test seam run after the rewrite is staged and before
// the final re-check, so a test can delete or alter the target in that window.
function resolveHandover(file, outcomeRaw, { beforeRename, nowMs = Date.now() } = {}) {
  const r = (code, message) => ({ code, message });
  const outcome = cleanValue('outcome', outcomeRaw);
  if (!file || !outcome) return r(2, 'usage: handover-resolve <file> --outcome "<text>"');
  const abs = path.resolve(file);
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return r(e.code === 'ENOENT' ? 2 : 1, `no such file: ${abs}`); }
  if (st.isSymbolicLink()) return r(3, `refusing symlink: ${abs}`);
  if (!st.isFile()) return r(2, `not a file: ${abs}`);
  const dir = path.dirname(abs);
  try { if (fs.lstatSync(dir).isSymbolicLink()) return r(3, `refusing symlinked directory: ${dir}`); } catch (e) { return r(1, `${dir}: ${e.code || e.message}`); }
  if (path.basename(path.dirname(abs)).toLowerCase() === '_archive') return r(2, `already archived: ${abs}`);
  if (!/handover/i.test(path.basename(abs))) return r(2, `not a handover file: ${abs}`);
  const h = readHandover(abs, nowMs);
  if (h.status === null) return r(2, `${abs}: ${h.reason}`);
  if (h.status === 'resolved') return r(4, `already resolved: ${abs}`);
  // Runs after the staged write; throws { resolveCode } when the target changed underneath us.
  const recheck = () => {
    if (beforeRename) beforeRename();
    const h2 = readHandover(abs, nowMs);
    if (h2.status === 'open') return;
    throw Object.assign(new Error('changed'), { resolveCode: h2.status === 'resolved' ? 4 : 2, resolveMsg: `${abs}: ${h2.status || h2.reason}` });
  };
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    if (h.kind === 'legacy') {
      recheck();
      fs.appendFileSync(abs, `${raw.endsWith('\n') ? '\n' : '\n\n'}FINAL OUTCOME: ${outcome}\n`);
    } else {
      const updated = applyHeaderUpdates(raw, { status: 'resolved', resolved: Math.floor(nowMs / 1000), outcome });
      atomicReplace(abs, updated, st.mode, recheck);
    }
  } catch (e) {
    if (e.resolveCode) return r(e.resolveCode, e.resolveMsg);
    return r(1, `${abs}: ${e.code || e.message}`);
  }
  return r(0, `resolved ${abs}`);
}

module.exports = {
  HEADER_KEYS,
  LEGACY_RESOLVED_RE,
  MAX_BYTES,
  STALE_OPEN_S,
  STALE_WARN_S,
  RESOLVED_ARCHIVE_S,
  EMPTY_GRACE_S,
  TMP_PREFIX,
  FUTURE_SKEW_S,
  classifyContent,
  readHandover,
  renderHeader,
  applyHeaderUpdates,
  atomicReplace,
  createExclusive,
  moveToArchive,
  resolveHandover,
};
