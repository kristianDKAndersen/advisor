// lib/vault.js — native vault: .md note CRUD, YAML frontmatter, SQLite FTS5 index.
// Runtime: Bun (bun:sqlite). Vault root: ~/.advisor/vault/ (overridable via ADVISOR_VAULT).
// DB: ~/.advisor/vault/.cache/vault.db

import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const VAULT_ROOT = process.env.ADVISOR_VAULT
  || path.join(os.homedir(), '.advisor', 'vault');
const DB_PATH = path.join(VAULT_ROOT, '.cache', 'vault.db');

// ── Lazy SQLite init ────────────────────────────────────────────────────────
let _db = null;
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      type TEXT, sid TEXT, seq INTEGER, agent TEXT, repo TEXT,
      created_at TEXT, material TEXT, next_action TEXT,
      established TEXT, gap TEXT, plan_ref TEXT, body TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
      USING fts5(path UNINDEXED, body, content='notes', content_rowid='rowid');
    CREATE TABLE IF NOT EXISTS links (
      source TEXT, target TEXT,
      PRIMARY KEY (source, target)
    );
  `);
  // migrate: add due_date column if schema predates it
  const cols = _db.prepare(`PRAGMA table_info(notes)`).all().map(r => r.name);
  if (!cols.includes('due_date')) {
    _db.exec(`ALTER TABLE notes ADD COLUMN due_date TEXT`);
  }
  return _db;
}

// ── Frontmatter helpers ─────────────────────────────────────────────────────
export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { fm: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: text };
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fm, body: text.slice(end + 5) };
}

export function serializeFrontmatter(fm, body) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${lines}\n---\n\n${body}`;
}

// ── Note CRUD ───────────────────────────────────────────────────────────────
export function writeNote(relPath, fm, body) {
  const abs = path.join(VAULT_ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeFrontmatter(fm, body));
  _upsertIndex(relPath, fm, body);
}

export function readNote(relPath) {
  const abs = path.join(VAULT_ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return parseFrontmatter(fs.readFileSync(abs, 'utf8'));
}

export function _upsertIndex(relPath, fm, body) {
  try {
    const d = db();
    d.prepare(`
      INSERT INTO notes (path, type, sid, seq, agent, repo, created_at,
                         material, next_action, established, gap, plan_ref, body, due_date)
      VALUES ($path,$type,$sid,$seq,$agent,$repo,$created_at,
              $material,$next_action,$established,$gap,$plan_ref,$body,$due_date)
      ON CONFLICT(path) DO UPDATE SET
        type=excluded.type, sid=excluded.sid, seq=excluded.seq,
        agent=excluded.agent, repo=excluded.repo,
        created_at=excluded.created_at, material=excluded.material,
        next_action=excluded.next_action, established=excluded.established,
        gap=excluded.gap, plan_ref=excluded.plan_ref, body=excluded.body,
        due_date=excluded.due_date
    `).run({
      $path: relPath, $type: fm.type || '', $sid: fm.sid || '',
      $seq: parseInt(fm.seq) || 0, $agent: fm.agent || '',
      $repo: fm.repo || '', $created_at: fm.created_at || '',
      $material: fm.material || '', $next_action: fm.next_action || '',
      $established: fm.established || '', $gap: fm.gap || '',
      $plan_ref: fm.plan_ref || '', $body: body,
      $due_date: fm.due_date || null
    });
    d.prepare(`INSERT OR REPLACE INTO notes_fts(path, body) VALUES (?,?)`).run(relPath, body);
    // wikilinks
    const targets = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
    const del = d.prepare(`DELETE FROM links WHERE source = ?`);
    const ins = d.prepare(`INSERT OR IGNORE INTO links (source, target) VALUES (?,?)`);
    d.transaction(() => {
      del.run(relPath);
      for (const t of targets) ins.run(relPath, t);
    })();
  } catch (_) { /* index is advisory; note write already succeeded */ }
}

// ── High-level writers called from channel.js and session.js ────────────────
export function writeSynthesisNote(record) {
  const rel = `synthesis/${record.sid}-${record.seq}.md`;
  const body = [
    `## Established\n${record.established}`,
    `## Gap\n${record.gap}`,
    record.key_quotes ? `## Key Quotes\n${record.key_quotes}` : ''
  ].filter(Boolean).join('\n\n');
  writeNote(rel, {
    type: 'synthesis', sid: record.sid, seq: record.seq,
    agent: record.agent || '', created_at: record.ts_iso,
    material: record.material, next_action: record.next_action,
    established: (record.established || '').replace(/\n/g, ' ').slice(0, 120),
    gap: (record.gap || '').replace(/\n/g, ' ').slice(0, 120)
  }, body);
}

export function writeSessionNote(meta) {
  const rel = `sessions/${meta.sid}.md`;
  const planLink = meta.plan_ref ? `[[${meta.plan_ref}]]` : '_none_';
  const body = [
    `## Task\n${meta.task || ''}`,
    `## Goal\n${meta.goal || ''}`,
    `## Plan\n${planLink}`
  ].join('\n\n');
  writeNote(rel, {
    type: 'session', sid: meta.sid, agent: meta.agent || '',
    repo: meta.repo || '', created_at: meta.created_at || new Date().toISOString(),
    plan_ref: meta.plan_ref || ''
  }, body);
}

export function writeLesson(record) {
  const ts = typeof record.ts === 'number' ? record.ts : Date.now() / 1000;
  // Use synthesis_seq in filename for guaranteed uniqueness (one lesson per failure event).
  const rel = `lessons/${record.sid}-${record.agent}-${record.synthesis_seq}.md`;
  const body = [
    `Tags: ${record.task_type || ''}`,
    `## Root cause\n${record.root_cause}`,
    `## Heuristic\n${record.heuristic}`,
    `## Evidence\nSynthesis seq: ${record.synthesis_seq} | Session: ${record.sid} | Score: ${record.evaluator_dim}=${record.score || 'n/a'}`
  ].filter(Boolean).join('\n\n');
  writeNote(rel, {
    type: 'lesson',
    sid: record.sid,
    agent: record.agent || '',
    created_at: record.ts_iso || new Date(ts * 1000).toISOString(),
    task_type: record.task_type || '',
    failure_mode: record.failure_mode || '',
    evaluator_dim: record.evaluator_dim || 'verdict:blocked',
    polarity: 'negative'
  }, body);
  // Append to lessons.jsonl audit log (same .cache dir as vault.db).
  const auditPath = path.join(VAULT_ROOT, '.cache', 'lessons.jsonl');
  const auditLine = {
    ts,
    sid: record.sid,
    agent: record.agent,
    task_type: record.task_type,
    failure_mode: record.failure_mode,
    heuristic: record.heuristic,
    path: rel
  };
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(auditLine) + '\n');
  } catch (_) { /* audit log is advisory; note write already succeeded */ }
}

export function indexPlanFile(absPath, planRef) {
  if (!fs.existsSync(absPath)) return;
  const text = fs.readFileSync(absPath, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  if (fm.type === 'plan') return;
  const newFm = {
    type: 'plan',
    plan_ref: planRef || path.basename(absPath, '.md'),
    created_at: new Date().toISOString(),
    ...fm
  };
  fs.writeFileSync(absPath, serializeFrontmatter(newFm, body));
  const rel = path.relative(VAULT_ROOT, absPath);
  _upsertIndex(
    rel.startsWith('..') ? `plans/${path.basename(absPath)}` : rel,
    newFm,
    body
  );
}

// ── Query (BM25 FTS5) ────────────────────────────────────────────────────────

// Wrap any whitespace-delimited token that contains a hyphen in FTS5 phrase
// quotes so "deep-research" is treated as a phrase rather than deep AND NOT research.
function _escapeQuery(text) {
  return text.split(/\s+/).map(token => {
    if (!token.includes('-') || token.startsWith('"')) return token;
    return `"${token}"`;
  }).join(' ');
}

export function searchNotes(text, limit = 10) {
  try {
    return db().prepare(`
      SELECT n.path, n.sid, n.type, n.created_at, n.material,
             snippet(notes_fts, 1, '<b>', '</b>', '…', 20) AS snippet
      FROM notes_fts f JOIN notes n ON n.path = f.path
      WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(_escapeQuery(text), limit);
  } catch (_) { return []; }
}

export function backlinks(noteName) {
  try {
    return db().prepare(`SELECT source FROM links WHERE target = ?`).all(noteName).map(r => r.source);
  } catch (_) { return []; }
}

// Returns reminder notes with due_date <= windowEnd (default: today + 14 days)
export function listDue(today = new Date().toISOString().slice(0, 10), windowDays = 14) {
  try {
    const d = new Date(today);
    d.setDate(d.getDate() + windowDays);
    const windowEnd = d.toISOString().slice(0, 10);
    return db().prepare(`
      SELECT path, type, created_at, established, body, due_date
      FROM notes
      WHERE type = 'reminder' AND due_date IS NOT NULL AND due_date <= ?
      ORDER BY due_date ASC
    `).all(windowEnd);
  } catch (_) { return []; }
}

// Returns {source, target} rows from links where target has no matching note
export function listUnresolved() {
  try {
    return db().prepare(`
      SELECT source, target FROM links
      WHERE target NOT IN (SELECT REPLACE(path, '.md', '') FROM notes)
    `).all();
  } catch (_) { return []; }
}

// ── Direct invocation smoke test ─────────────────────────────────────────────
if (import.meta.main) {
  console.log('vault.js self-test — VAULT_ROOT:', VAULT_ROOT);
  const testRec = {
    sid: 'test-sid', seq: 1,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'Test established content for smoke test.',
    gap: 'none',
    material: 'no',
    next_action: 'proceed-to-step-8',
    key_quotes: ''
  };
  writeSynthesisNote(testRec);
  const results = searchNotes('smoke test');
  console.log('searchNotes("smoke test"):', results.length, 'result(s)');
  if (results.length > 0) {
    console.log('  path:', results[0].path);
    console.log('  snippet:', results[0].snippet);
  }
  console.log('vault.js self-test PASSED');
}
