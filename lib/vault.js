// lib/vault.js — native vault: .md note CRUD, YAML frontmatter, SQLite FTS5 index.
// Runtime: Bun (bun:sqlite). Vault root: ~/.advisor/vault/ (overridable via ADVISOR_VAULT).
// DB: ~/.advisor/vault/.cache/vault.db

const { Database } = require('bun:sqlite');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function vaultRoot() {
  return process.env.ADVISOR_VAULT || path.join(os.homedir(), '.advisor', 'vault');
}
function dbPath() { return path.join(vaultRoot(), '.cache', 'vault.db'); }

// Test-only: inject a synchronous delay between readNote and writeNote to
// expose TOCTOU races. Set ADVISOR_TEST_NOTE_DELAY_MS before loading this module.
const _testNoteLockDelayMs = parseInt(process.env.ADVISOR_TEST_NOTE_DELAY_MS || '0', 10);

// ── Lazy SQLite init ────────────────────────────────────────────────────────
let _db = null;
let _dbPath = null;
function db() {
  const currentPath = dbPath();
  if (_db && _dbPath === currentPath) return _db;
  if (_db && _dbPath !== currentPath) { try { _db.close(); } catch (_) {} _db = null; }
  _dbPath = currentPath;
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  _db = new Database(currentPath);
  _db.exec('PRAGMA journal_mode=WAL');
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
      kind TEXT DEFAULT 'wikilink',
      confidence TEXT DEFAULT 'EXTRACTED',
      PRIMARY KEY (source, target)
    );
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, path, body) VALUES (new.rowid, new.path, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, body) VALUES('delete', old.rowid, old.path, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, body) VALUES('delete', old.rowid, old.path, old.body);
      INSERT INTO notes_fts(rowid, path, body) VALUES (new.rowid, new.path, new.body);
    END;
  `);
  // migrate: add columns if schema predates them
  const cols = _db.prepare(`PRAGMA table_info(notes)`).all().map(r => r.name);
  if (!cols.includes('due_date')) {
    _db.exec(`ALTER TABLE notes ADD COLUMN due_date TEXT`);
  }
  const bitemporalCols = ['fetched_at', 'published_at', 'content_hash', 't_valid', 't_invalid'];
  for (const col of bitemporalCols) {
    if (!cols.includes(col)) {
      try { _db.exec(`ALTER TABLE notes ADD COLUMN ${col} TEXT`); } catch (_) {}
    }
  }
  if (!cols.includes('task_hash')) {
    try { _db.exec(`ALTER TABLE notes ADD COLUMN task_hash TEXT`); } catch (_) {}
  }
  if (!cols.includes('worker_verdict')) {
    try { _db.exec(`ALTER TABLE notes ADD COLUMN worker_verdict TEXT`); } catch (_) {}
  }
  if (!cols.includes('status')) {
    try { _db.exec(`ALTER TABLE notes ADD COLUMN status TEXT`); } catch (_) {}
  }
  // migrate: embeddings table for local semantic vectors (P7)
  const embTables = _db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`).all();
  if (!embTables.length) {
    _db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      computed_at INTEGER NOT NULL
    )`);
  }
  // migrate links: add kind/confidence if schema predates them
  const linkCols = _db.prepare(`PRAGMA table_info(links)`).all().map(r => r.name);
  if (!linkCols.includes('kind')) {
    try { _db.exec(`ALTER TABLE links ADD COLUMN kind TEXT DEFAULT 'wikilink'`); } catch (_) {}
  }
  if (!linkCols.includes('confidence')) {
    try { _db.exec(`ALTER TABLE links ADD COLUMN confidence TEXT DEFAULT 'EXTRACTED'`); } catch (_) {}
  }
  return _db;
}

// ── Frontmatter helpers ─────────────────────────────────────────────────────
function parseFrontmatter(text) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---\n')) return { fm: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: text };
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) continue;
    fm[key] = line.slice(colon + 1).trim();
  }
  return { fm, body: text.slice(end + 5) };
}

function serializeFrontmatter(fm, body) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${lines}\n---\n\n${body}`;
}

// ── Note CRUD ───────────────────────────────────────────────────────────────
function writeNote(relPath, fm, body) {
  const abs = path.join(vaultRoot(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeFrontmatter(fm, body));
  _upsertIndex(relPath, fm, body);
}

function readNote(relPath) {
  const abs = path.join(vaultRoot(), relPath);
  if (!fs.existsSync(abs)) return null;
  return parseFrontmatter(fs.readFileSync(abs, 'utf8'));
}

function rebuildIndex() {
  // Save embeddings before wiping DB so they survive the rebuild
  const targetDbPath = dbPath();
  let savedEmbeddings = [];
  try {
    if (_db && _dbPath === targetDbPath) {
      savedEmbeddings = _db.prepare(`SELECT path,content_hash,vector,computed_at FROM embeddings`).all();
    } else if (fs.existsSync(targetDbPath)) {
      const tmp = new Database(targetDbPath);
      savedEmbeddings = tmp.prepare(`SELECT path,content_hash,vector,computed_at FROM embeddings`).all();
      tmp.close();
    }
  } catch (_) {}

  if (_db) { try { _db.close(); } catch (_) {} _db = null; }
  const base = dbPath();
  for (const ext of ['', '-wal', '-shm']) {
    try { if (fs.existsSync(base + ext)) fs.unlinkSync(base + ext); } catch (_) {}
  }
  let indexed = 0;
  const root = vaultRoot();
  const cacheDir = path.join(root, '.cache');

  // Pre-scan: collect all .md basenames for link-target denoising (P6a)
  const knownBasenames = new Set();
  function scanBasenames(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== cacheDir) scanBasenames(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        knownBasenames.add(entry.name.slice(0, -3));
      }
    }
  }
  scanBasenames(root);

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== cacheDir) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const rel = path.relative(root, full);
        try {
          const text = fs.readFileSync(full, 'utf8');
          const { fm, body } = parseFrontmatter(text);
          _upsertIndex(rel, fm, body, knownBasenames);
          indexed++;
        } catch (_) {}
      }
    }
  }
  walk(root);

  // Restore embeddings that were saved before the DB wipe
  if (savedEmbeddings.length) {
    try {
      const d = db();
      const ins = d.prepare(`INSERT OR IGNORE INTO embeddings (path,content_hash,vector,computed_at) VALUES (?,?,?,?)`);
      d.transaction(() => { for (const e of savedEmbeddings) ins.run(e.path, e.content_hash, e.vector, e.computed_at); })();
    } catch (_) {}
  }

  // P6b: auto-recompute communities if graph has meaningful edges
  let commResult = null;
  try {
    const linkCount = db().prepare(`SELECT COUNT(*) AS cnt FROM links`).get().cnt;
    if (linkCount > 10) commResult = computeCommunities();
  } catch (_) {}

  return { indexed, communities: commResult };
}

function deleteNote(relPath) {
  const abs = path.join(vaultRoot(), relPath);
  if (!fs.existsSync(abs)) return { deleted: false };
  fs.unlinkSync(abs);
  try {
    const d = db();
    d.prepare(`DELETE FROM notes WHERE path = ?`).run(relPath);
    d.prepare(`DELETE FROM links WHERE source = ? OR target = ?`).run(relPath, relPath);
  } catch (_) {}
  return { deleted: true };
}

function previewDeleteNote(relPath) {
  const abs = path.join(vaultRoot(), relPath);
  try {
    const links = db().prepare(`SELECT source, target FROM links WHERE source = ? OR target = ?`).all(relPath, relPath);
    return { absPath: abs, exists: fs.existsSync(abs), links };
  } catch (_) { return { absPath: abs, exists: fs.existsSync(abs), links: [] }; }
}

// P9b — prune test-fixture stub notes from vault and DB
function pruneFixtures({ dryRun = false, minBodyLength = 20 } = {}) {
  const fixturePrefix = /^(verdict-test-|test-checkpoint-|test-)/;
  const d = db();
  const allNotes = d.prepare(`SELECT path, body FROM notes`).all();
  const toDelete = [];
  for (const note of allNotes) {
    const baseName = path.basename(note.path);
    const isFixture = fixturePrefix.test(baseName);
    const bodyLen = (note.body || '').trim().length;
    const isShort = bodyLen < minBodyLength;
    if (isFixture || isShort) {
      toDelete.push({ path: note.path, reason: isFixture ? 'prefix-match' : 'short-body', preview: (note.body || '').slice(0, 60) });
    }
  }
  if (!dryRun) {
    const delNote = d.prepare(`DELETE FROM notes WHERE path = ?`);
    const delLinks = d.prepare(`DELETE FROM links WHERE source = ? OR target = ?`);
    const delEmb = d.prepare(`DELETE FROM embeddings WHERE path = ?`);
    for (const note of toDelete) {
      const abs = path.join(vaultRoot(), note.path);
      if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
      delNote.run(note.path);
      delLinks.run(note.path, note.path);
      delEmb.run(note.path);
    }
  }
  return { count: toDelete.length, pruned: toDelete };
}

function _upsertIndex(relPath, fm, body, knownBasenames = null) {
  try {
    const d = db();
    d.prepare(`
      INSERT INTO notes (path, type, sid, seq, agent, repo, created_at,
                         material, next_action, established, gap, plan_ref, body, due_date,
                         fetched_at, published_at, content_hash, t_valid, t_invalid, task_hash,
                         status)
      VALUES ($path,$type,$sid,$seq,$agent,$repo,$created_at,
              $material,$next_action,$established,$gap,$plan_ref,$body,$due_date,
              $fetched_at,$published_at,$content_hash,$t_valid,$t_invalid,$task_hash,
              $status)
      ON CONFLICT(path) DO UPDATE SET
        type=excluded.type, sid=excluded.sid, seq=excluded.seq,
        agent=excluded.agent, repo=excluded.repo,
        created_at=excluded.created_at, material=excluded.material,
        next_action=excluded.next_action, established=excluded.established,
        gap=excluded.gap, plan_ref=excluded.plan_ref, body=excluded.body,
        due_date=excluded.due_date,
        fetched_at=excluded.fetched_at, published_at=excluded.published_at,
        content_hash=excluded.content_hash, t_valid=excluded.t_valid,
        t_invalid=excluded.t_invalid, task_hash=excluded.task_hash,
        status=excluded.status
    `).run({
      $path: relPath, $type: fm.type || '', $sid: fm.sid || '',
      $seq: parseInt(fm.seq) || 0, $agent: fm.agent || '',
      $repo: fm.repo || '', $created_at: fm.created_at || '',
      $material: fm.material || '', $next_action: fm.next_action || '',
      $established: fm.established || '', $gap: fm.gap || '',
      $plan_ref: fm.plan_ref || '', $body: body,
      $due_date: fm.due_date || null,
      $fetched_at: fm.fetched_at ?? '', $published_at: fm.published_at ?? '',
      $content_hash: fm.content_hash ?? '', $t_valid: fm.t_valid ?? '',
      $t_invalid: fm.t_invalid ?? '', $task_hash: fm.task_hash ?? '',
      $status: fm.status || null
    });
    // wikilinks — validate targets to reject spurious plain-word entries (P6a)
    let bnames = knownBasenames;
    let ghostOk = false;
    if (!bnames) {
      // Fallback when called outside rebuildIndex: query DB + include self
      const noteRows = d.prepare(`SELECT path FROM notes`).all();
      bnames = new Set(noteRows.map(r => r.path.replace(/^.*\//, '').replace(/\.md$/, '')));
      bnames.add(relPath.replace(/^.*\//, '').replace(/\.md$/, ''));
      ghostOk = true; // live write path: accept slug-form forward references
    }
    const targets = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
    const del = d.prepare(`DELETE FROM links WHERE source = ?`);
    const ins = d.prepare(`INSERT OR IGNORE INTO links (source, target, kind, confidence) VALUES (?,?,'wikilink','EXTRACTED')`);
    d.transaction(() => {
      del.run(relPath);
      for (const t of targets) {
        if (_isValidLinkTarget(t, bnames, ghostOk)) ins.run(relPath, t);
      }
    })();
  } catch (_) { /* index is advisory; note write already succeeded */ }
}

// ── High-level writers called from channel.js and session.js ────────────────

// Matches advisor session IDs of form <10-digit-unix-ts>-<6-hex-chars>
const SID_RE = /\b(?:17[0-9]{8}|[0-9]{10})-[0-9a-f]{6}\b/g;
// Exact-match validators for link target denoising (P6a)
const _SID_EXACT     = /^(?:17[0-9]{8}|[0-9]{10})-[0-9a-f]{6}$/;
const _SID_SEQ_EXACT = /^(?:17[0-9]{8}|[0-9]{10})-[0-9a-f]{6}-\d+$/;
// Slug pattern: single-token targets with no spaces are intentional ghost links
const _SLUG_RE       = /^[a-z0-9][a-z0-9._\-\/]*$/i;
function _isValidLinkTarget(t, knownBasenames, allowGhost) {
  if (!t) return false;
  if (t.startsWith('http://') || t.startsWith('https://')) return true;
  if (_SID_EXACT.test(t) || _SID_SEQ_EXACT.test(t)) return true;
  const bn = t.replace(/^.*\//, '').replace(/\.md$/, '');
  if (knownBasenames.has(bn) || knownBasenames.has(t)) return true;
  // Accept ghost wikilinks (forward refs) only on live writes, not during rebuildIndex batch
  return allowGhost === true && _SLUG_RE.test(t);
}
function extractSids(text) {
  return [...(text || '').matchAll(SID_RE)].map(m => m[0]);
}

function writeSynthesisNote(record) {
  const rel = `synthesis/${record.sid}-${record.seq}.md`;
  const textBlob = [record.established, record.gap, record.next_action, record.key_quotes].join(' ');
  const relatedSids = [...new Set([record.sid, ...extractSids(textBlob)])].filter(Boolean);
  const relatedSection = relatedSids.length > 0
    ? `\n\n## Related\n${relatedSids.map(s => `[[${s}]]`).join(' ')}`
    : '';
  const body = [
    `## Established\n${record.established}`,
    `## Gap\n${record.gap}`,
    record.key_quotes ? `## Key Quotes\n${record.key_quotes}` : ''
  ].filter(Boolean).join('\n\n') + relatedSection;
  writeNote(rel, {
    type: 'synthesis', sid: record.sid, seq: record.seq,
    agent: record.agent || '', created_at: record.ts_iso,
    material: record.material, next_action: record.next_action,
    established: (record.established || '').replace(/\n/g, ' ').slice(0, 120),
    gap: (record.gap || '').replace(/\n/g, ' ').slice(0, 120),
    fetched_at: record.fetched_at ?? '',
    published_at: record.published_at ?? '',
    content_hash: record.content_hash ?? '',
    t_valid: record.t_valid ?? '',
    t_invalid: record.t_invalid ?? '',
    task_hash: record.task_hash ?? ''
  }, body);
}

function writeSessionNote(meta) {
  const rel = `sessions/${meta.sid}.md`;
  const planLink = meta.plan_ref ? `[[${meta.plan_ref}]]` : '_none_';
  const priorSids = [...new Set(extractSids([meta.task, meta.goal].join(' ')))].filter(Boolean);
  const relatedSection = priorSids.length > 0
    ? `\n\n## Related\n${priorSids.map(s => `[[${s}]]`).join(' ')}`
    : '';
  const body = [
    `## Task\n${meta.task || ''}`,
    `## Goal\n${meta.goal || ''}`,
    `## Plan\n${planLink}`
  ].join('\n\n') + relatedSection;
  writeNote(rel, {
    type: 'session', sid: meta.sid, agent: meta.agent || '',
    repo: meta.repo || '', created_at: meta.created_at || new Date().toISOString(),
    plan_ref: meta.plan_ref || ''
  }, body);
}

function writeLesson(record) {
  const ts = typeof record.ts === 'number' ? record.ts : Date.now() / 1000;
  // Use synthesis_seq in filename for guaranteed uniqueness (one lesson per failure event).
  const rel = `lessons/${record.sid}-${record.agent}-${record.synthesis_seq}.md`;
  const body = [
    `Tags: ${record.task_type || ''}`,
    `## Root cause\n${record.root_cause}`,
    `## Heuristic\n${record.heuristic}`,
    `## Evidence\nSynthesis seq: ${record.synthesis_seq} | Session: ${record.sid} | Score: ${record.evaluator_dim}=${record.score || 'n/a'}`,
    `## Related\n[[${record.sid}]]`
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
  const auditPath = path.join(vaultRoot(), '.cache', 'lessons.jsonl');
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

function indexPlanFile(absPath, planRef) {
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
  const rel = path.relative(vaultRoot(), absPath);
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

function searchNotes(text, limit = 10) {
  try {
    return db().prepare(`
      SELECT n.path, n.sid, n.type, n.created_at, n.material,
             snippet(notes_fts, 1, '<b>', '</b>', '…', 20) AS snippet
      FROM notes_fts f JOIN notes n ON n.path = f.path
      WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(_escapeQuery(text), limit);
  } catch (_) { return []; }
}

function backlinks(noteName) {
  try {
    return db().prepare(`SELECT source FROM links WHERE target = ?`).all(noteName).map(r => r.source);
  } catch (_) { return []; }
}

// Notes with one of these status values are excluded from listDue.
// Update both this constant and the setStatus call sites when adding a new
// dismissed state (e.g. 'snoozed') — grep DISMISSED_STATUSES to find the SQL.
const DISMISSED_STATUSES = ['done', 'archived'];

// Returns reminder notes with due_date <= windowEnd (default: today + 14 days)
function listDue(today = new Date().toISOString().slice(0, 10), windowDays = 14) {
  try {
    const [y, m, dd] = today.split('-').map(Number);
    const t = Date.UTC(y, m - 1, dd) + windowDays * 86400000;
    const windowEnd = new Date(t).toISOString().slice(0, 10);
    const placeholders = DISMISSED_STATUSES.map(() => '?').join(',');
    return db().prepare(`
      SELECT path, type, created_at, established, body, due_date
      FROM notes
      WHERE due_date IS NOT NULL AND due_date <= ?
            AND (status IS NULL OR status NOT IN (${placeholders}))
      ORDER BY due_date ASC
    `).all(windowEnd, ...DISMISSED_STATUSES);
  } catch (_) { return []; }
}

// Returns {source, target} rows from links where target has no matching note
function listUnresolved() {
  try {
    return db().prepare(`
      SELECT source, target FROM links
      WHERE target NOT IN (
        SELECT REPLACE(path, '.md', '') FROM notes
        UNION
        SELECT REPLACE(SUBSTR(path, INSTR(path,'/')+1), '.md', '') FROM notes WHERE path LIKE '%/%'
      )
    `).all();
  } catch (_) { return []; }
}

function neighbors(noteName, depth = 1) {
  // depth=1 only; returns direct adjacency with link metadata.
  // Accepts both full-path form ('projects/foo.md') and basename form ('foo'):
  //   out direction: source column stores file paths, so we match exact, +.md, or any-dir/name.md
  //   in  direction: target column stores wikilink text (basename-style), so we also try basename
  try {
    const d = db();
    const out = d.prepare(`
      SELECT target AS note, kind, confidence, 'out' AS direction FROM links
      WHERE source = ? OR source = ? || '.md' OR source LIKE '%/' || ? || '.md'
    `).all(noteName, noteName, noteName);
    const bn = noteName.replace(/^.*\//, '').replace(/\.md$/, '');
    const inc = d.prepare(`
      SELECT source AS note, kind, confidence, 'in' AS direction FROM links
      WHERE target = ? OR target = ?
    `).all(noteName, bn);
    const seen = new Set();
    return [...out, ...inc].filter(r => {
      const k = r.direction + ':' + r.note;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  } catch (_) { return []; }
}

function shortestPath(from, to) {
  if (from === to) return [from];
  try {
    // The join handles the mismatch between link sources (file paths like 'sp-b.md')
    // and link targets (wikilink text like 'sp-b'): a node matching 'sp-b' also
    // activates outgoing links from 'sp-b.md' and 'subdir/sp-b.md'.
    const rows = db().prepare(`
      WITH RECURSIVE path(node, route, visited, depth) AS (
        SELECT ?1, ?1, '|' || ?1 || '|', 0
        UNION ALL
        SELECT l.target,
               path.route || ' -> ' || l.target,
               path.visited || l.target || '|',
               path.depth + 1
        FROM links l
        JOIN path ON (
          l.source = path.node
          OR l.source = path.node || '.md'
          OR l.source LIKE '%/' || path.node || '.md'
        )
        WHERE path.depth < 10
          AND path.visited NOT LIKE '%|' || l.target || '|%'
      )
      SELECT route FROM path WHERE node = ?2 LIMIT 1
    `).all(from, to);
    if (!rows.length) return [];
    return rows[0].route.split(' -> ');
  } catch (_) { return []; }
}

function listHubs(limit = 20) {
  try {
    return db().prepare(`
      SELECT target, COUNT(*) AS deg FROM links GROUP BY target ORDER BY deg DESC LIMIT ?
    `).all(limit);
  } catch (_) { return []; }
}

function listGaps(limit = 20) {
  try {
    return db().prepare(`
      SELECT path, sid, created_at, established, gap
      FROM notes
      WHERE worker_verdict = 'blocked'
        AND type = 'synthesis'
        AND sid NOT IN (SELECT sid FROM notes WHERE type = 'lesson')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  } catch (_) { return []; }
}

function setWorkerVerdict(relPath, verdict) {
  try {
    db().prepare(`UPDATE notes SET worker_verdict = ? WHERE path = ?`).run(verdict, relPath);
  } catch (_) {}
}

// parseFrontmatter only handles single-line `key: value` pairs; round-tripping
// a note with YAML arrays or block scalars would silently drop those lines.
// Refuse the operation instead.
function _assertSingleLineFrontmatter(relPath) {
  const abs = path.join(vaultRoot(), relPath);
  if (!fs.existsSync(abs)) return;
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---\n')) return;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return;
  for (const line of text.slice(4, end).split('\n')) {
    if (line === '') continue;
    if (/^\s/.test(line) || line.indexOf(':') === -1) {
      throw new Error(`multi-line frontmatter not supported by setStatus/setDueDate — frontmatter at ${relPath} has continuation lines`);
    }
  }
}

// POSIX-atomic mkdir-spinlock that serialises cross-process read-modify-write
// operations on a single vault note. Lock dir lives under <vaultRoot>/.locks/
// so it never touches the note file itself. Stale locks (>30s old) are removed
// automatically to recover from hard kills.
function withNoteLock(relPath, fn) {
  const slug = relPath.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  const locksDir = path.join(vaultRoot(), '.locks');
  fs.mkdirSync(locksDir, { recursive: true });
  const lockDir = path.join(locksDir, slug + '.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lockDir); // POSIX-atomic: throws EEXIST when lock is held
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(lockDir); } catch (_) {}
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Remove stale lock left by a hard-killed process
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 30000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) {
        throw new Error(`withNoteLock: timeout after 5s for ${relPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function setStatus(relPath, status) {
  withNoteLock(relPath, () => {
    const note = readNote(relPath);
    if (!note) return;
    _assertSingleLineFrontmatter(relPath);
    if (_testNoteLockDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, _testNoteLockDelayMs);
    writeNote(relPath, { ...note.fm, status }, note.body);
    try { db().prepare(`UPDATE notes SET status = ? WHERE path = ?`).run(status, relPath); } catch (_) {}
  });
}

function setDueDate(relPath, isoDate) {
  withNoteLock(relPath, () => {
    const note = readNote(relPath);
    if (!note) return;
    _assertSingleLineFrontmatter(relPath);
    if (_testNoteLockDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, _testNoteLockDelayMs);
    writeNote(relPath, { ...note.fm, due_date: isoDate }, note.body);
  });
}

function backfillVerdicts(dryRun = false, runsDir = null) {
  const runs = runsDir || path.join(os.homedir(), '.advisor', 'runs');
  const d = db();
  const candidates = d.prepare(
    `SELECT path, sid FROM notes WHERE type = 'synthesis' AND worker_verdict IS NULL AND sid != ''`
  ).all();

  let backfilled = 0, skippedLegacy = 0, skippedMissing = 0;
  const report = [];

  for (const row of candidates) {
    const outboxPath = path.join(runs, row.sid, 'channel', 'outbox.jsonl');
    if (!fs.existsSync(outboxPath)) {
      skippedMissing++;
      report.push({ sid: row.sid, path: row.path, status: 'missing-outbox' });
      continue;
    }

    const lines = fs.readFileSync(outboxPath, 'utf8').split('\n').filter(l => l.trim());
    let verdict = null;
    let legacyProse = false;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'result') continue;
        let body = msg.body;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch (_) { legacyProse = true; break; }
        }
        if (body && typeof body === 'object' && body.verdict) { verdict = body.verdict; break; }
      } catch (_) {}
    }

    if (verdict) {
      if (!dryRun) {
        d.prepare(`UPDATE notes SET worker_verdict = ? WHERE path = ?`).run(verdict, row.path);
      }
      backfilled++;
      report.push({ sid: row.sid, path: row.path, status: dryRun ? 'would-set' : 'set', verdict });
    } else if (legacyProse) {
      skippedLegacy++;
      report.push({ sid: row.sid, path: row.path, status: 'legacy-prose' });
    } else {
      skippedMissing++;
      report.push({ sid: row.sid, path: row.path, status: 'no-result-msg' });
    }
  }

  return { total: candidates.length, backfilled, skippedLegacy, skippedMissing, report };
}

// ── Phase 5: Retroactive Related-section rewrite ─────────────────────────────

function retroLink(opts = {}) {
  const { dryRun = false, limit = 0 } = opts;
  const root = vaultRoot();
  const d = db();

  let rows = d.prepare(`
    SELECT path, type, sid, body FROM notes
    WHERE type IN ('synthesis','session','lesson','project')
  `).all();

  if (limit > 0) rows = rows.slice(0, limit);

  let candidates = 0, rewritten = 0, skippedNoSids = 0, skippedHasSection = 0;

  for (const row of rows) {
    candidates++;
    const abs = path.join(root, row.path);
    if (!fs.existsSync(abs)) continue;

    const rawText = fs.readFileSync(abs, 'utf8');
    const { fm, body } = parseFrontmatter(rawText);

    if (body.includes('## Related')) { skippedHasSection++; continue; }

    // Extract SIDs from body content + the note's own sid
    const sids = [...new Set(extractSids(body + ' ' + (fm.sid || '')))].filter(Boolean);
    if (!sids.length) { skippedNoSids++; continue; }

    if (!dryRun) {
      const relatedSection = `\n\n## Related\n${sids.map(s => `[[${s}]]`).join(' ')}`;
      fs.writeFileSync(abs, rawText.trimEnd() + relatedSection);
    }
    rewritten++;
  }

  if (!dryRun) rebuildIndex();

  return { candidates, rewritten, skippedNoSids, skippedHasSection };
}

// ── Phase 5: Community detection (Louvain) ───────────────────────────────────

function _louvain(nodes, adj) {
  // adj: Map<node, Map<neighbor, weight>>
  // Returns: Map<node, community_id>
  let totalW = 0;
  for (const nb of adj.values()) for (const w of nb.values()) totalW += w;
  const m = totalW / 2; // undirected edge count
  if (m === 0) { const c = new Map(); nodes.forEach((n, i) => c.set(n, i)); return c; }

  const degree = n => { let s = 0; for (const w of (adj.get(n)?.values() || [])) s += w; return s; };
  const comm = new Map();
  nodes.forEach((n, i) => comm.set(n, i));

  let improved = true;
  let itr = 0;
  while (improved && itr++ < 200) {
    improved = false;
    for (const node of nodes) {
      const curComm = comm.get(node);
      const k_i = degree(node);

      // sumTot per community excluding this node
      const sumTot = new Map();
      for (const [n, c] of comm) {
        if (n === node) continue;
        sumTot.set(c, (sumTot.get(c) || 0) + degree(n));
      }

      // edges from node to each community
      const kToComm = new Map();
      for (const [nb, w] of (adj.get(node) || new Map())) {
        const c = comm.get(nb);
        if (c !== undefined) kToComm.set(c, (kToComm.get(c) || 0) + w);
      }

      let bestGain = -Infinity;
      let bestComm = curComm;
      for (const c of new Set([curComm, ...kToComm.keys()])) {
        const k_in = kToComm.get(c) || 0;
        const s_tot = sumTot.get(c) || 0;
        const dQ = k_in / m - s_tot * k_i / (2 * m * m);
        if (dQ > bestGain) { bestGain = dQ; bestComm = c; }
      }

      if (bestComm !== curComm) { comm.set(node, bestComm); improved = true; }
    }
  }

  // Normalize IDs
  const idMap = new Map(); let nextId = 0;
  const normalized = new Map();
  for (const [n, c] of comm) {
    if (!idMap.has(c)) idMap.set(c, nextId++);
    normalized.set(n, idMap.get(c));
  }
  return normalized;
}

function computeCommunities(opts = {}) {
  const d = db();

  // Schema migration
  const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='communities'`).all();
  if (!tables.length) {
    d.exec(`CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY,
      node TEXT NOT NULL,
      community_id INTEGER NOT NULL,
      computed_at INTEGER NOT NULL
    )`);
  }

  const linkRows = d.prepare(`SELECT source, target FROM links`).all();

  const bn = s => s.replace(/^.*\//, '').replace(/\.md$/, '');

  // Deduplicate to undirected edges (each pair once, weight=1)
  const adj = new Map();
  const nodeSet = new Set();
  const seenEdges = new Set();
  for (const row of linkRows) {
    const src = bn(row.source);
    const tgt = bn(row.target);
    if (src === tgt || !src || !tgt) continue;
    const edgeKey = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
    if (seenEdges.has(edgeKey)) { nodeSet.add(src); nodeSet.add(tgt); continue; }
    seenEdges.add(edgeKey);
    nodeSet.add(src); nodeSet.add(tgt);
    if (!adj.has(src)) adj.set(src, new Map());
    if (!adj.has(tgt)) adj.set(tgt, new Map());
    adj.get(src).set(tgt, 1);
    adj.get(tgt).set(src, 1);
  }

  const nodes = [...nodeSet];
  if (!nodes.length) return { communities: 0, nodes: 0, modularity: 0 };

  const commMap = _louvain(nodes, adj);

  // Modularity Q = Σ_c [e_c/m - (a_c/2m)²]  (Newman-Girvan, undirected)
  const m = seenEdges.size;
  const degree = n => { let s = 0; for (const w of (adj.get(n)?.values() || [])) s += w; return s; };
  const commEdges = new Map(); const commDegSum = new Map();
  for (const node of nodes) {
    const c = commMap.get(node);
    commDegSum.set(c, (commDegSum.get(c) || 0) + degree(node));
  }
  for (const edgeKey of seenEdges) {
    const [src, tgt] = edgeKey.split('|');
    if (commMap.get(src) === commMap.get(tgt)) {
      const c = commMap.get(src);
      commEdges.set(c, (commEdges.get(c) || 0) + 1);
    }
  }
  let Q = 0;
  for (const [c, a_c] of commDegSum) {
    const e_c = commEdges.get(c) || 0;
    Q += (m > 0 ? e_c / m : 0) - Math.pow(a_c / (2 * m), 2);
  }
  Q = Math.round(Q * 1000) / 1000;

  const now = Math.floor(Date.now() / 1000);
  d.exec(`DELETE FROM communities`);
  const ins = d.prepare(`INSERT INTO communities (node, community_id, computed_at) VALUES (?, ?, ?)`);
  d.transaction(() => { for (const [node, cid] of commMap) ins.run(node, cid, now); })();

  return { communities: new Set(commMap.values()).size, nodes: nodes.length, modularity: Q };
}

function listCommunities(limit = 20) {
  try {
    const d = db();
    const rows = d.prepare(`
      SELECT community_id, COUNT(*) AS size, GROUP_CONCAT(node, ', ') AS members
      FROM communities
      GROUP BY community_id
      ORDER BY size DESC
      LIMIT ?
    `).all(limit);

    if (!rows.length) return [];

    // Collect all unique nodes across these communities for batch enrichment
    const allNodeSet = new Set();
    for (const r of rows) {
      for (const n of (r.members || '').split(', ')) if (n) allNodeSet.add(n);
    }

    // Batch fetch notes whose basename matches a community node
    const notesByBasename = new Map();
    const allNoteRows = d.prepare(`SELECT path, established, created_at FROM notes`).all();
    for (const note of allNoteRows) {
      const bn = note.path.replace(/^.*\//, '').replace(/\.md$/, '');
      if (allNodeSet.has(bn) && !notesByBasename.has(bn)) notesByBasename.set(bn, note);
    }

    // Fetch all links for intra-community edge counting
    const linkRows = d.prepare(`SELECT source, target FROM links`).all();
    const bnOf = s => s.replace(/^.*\//, '').replace(/\.md$/, '');

    // Build per-community node sets for edge density
    const commNodeSets = new Map();
    for (const r of rows) {
      const members = (r.members || '').split(', ').filter(Boolean);
      commNodeSets.set(r.community_id, new Set(members));
    }

    // Count intra-community directed links
    const intraCounts = new Map();
    for (const r of rows) intraCounts.set(r.community_id, 0);
    for (const link of linkRows) {
      const s = bnOf(link.source), t = bnOf(link.target);
      if (s === t) continue;
      for (const [cid, nodeSet] of commNodeSets) {
        if (nodeSet.has(s) && nodeSet.has(t)) {
          intraCounts.set(cid, (intraCounts.get(cid) || 0) + 1);
        }
      }
    }

    return rows.map(r => {
      const members = (r.members || '').split(', ').filter(Boolean);

      const representative_titles = members.slice(0, 3).map(node => {
        const note = notesByBasename.get(node);
        if (!note) return null;
        return ((note.established || note.path) + '').slice(0, 80) || null;
      });

      let minCa = null, maxCa = null;
      for (const node of members) {
        const note = notesByBasename.get(node);
        if (note && note.created_at) {
          if (!minCa || note.created_at < minCa) minCa = note.created_at;
          if (!maxCa || note.created_at > maxCa) maxCa = note.created_at;
        }
      }

      const intraEdges = intraCounts.get(r.community_id) || 0;
      const maxEdges = members.length * (members.length - 1);
      const edge_density = maxEdges > 0 ? Math.round((intraEdges / maxEdges) * 1000) / 1000 : 0;

      return {
        community_id: r.community_id,
        size: r.size,
        members,
        representative_titles,
        time_range: { min: minCa, max: maxCa },
        edge_density
      };
    });
  } catch (_) { return []; }
}

// ── Phase 7: Local semantic embedding + similarity edges ─────────────────────

// Pairwise cosine similarity (naive O(N²) — acceptable for ≤1,500 notes).
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// embedNotes — embed vault notes with local transformer model; insert cosine-similar pairs as links.
// _pipelineFactory: for testing — sync factory returning async (text) => { data: Float32Array }.
// Production model: Xenova/all-MiniLM-L6-v2 (384-dim, ~25MB ONNX, offline after first download).
async function embedNotes({ limit = 0, threshold = 0.97, topK = 5, force = false, onlyChanged = false, dryRun = false, _pipelineFactory = null } = {}) {
  const d = db();

  let rows = d.prepare(`
    SELECT path, body FROM notes
    WHERE type IN ('synthesis','session','lesson','project')
  `).all();
  if (limit > 0) rows = rows.slice(0, limit);

  // Load pipeline: injected factory for tests, else @xenova/transformers
  let pipe;
  if (_pipelineFactory) {
    pipe = _pipelineFactory();
  } else {
    const mod = await import('@xenova/transformers');
    const { pipeline } = mod.default || mod;
    pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }

  let embedded = 0, skipped_hash = 0;

  for (const row of rows) {
    const normalized = (row.body || '').replace(/\s+/g, ' ').trim();
    const hash = createHash('sha256').update(normalized).digest('hex');

    if (!force) {
      const existing = d.prepare(`SELECT content_hash FROM embeddings WHERE path = ?`).get(row.path);
      if (existing && existing.content_hash === hash) { skipped_hash++; continue; }
    }

    const output = await pipe(normalized);
    // output.data is Float32Array; store raw bytes as BLOB
    const f32 = output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
    const vec = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

    d.prepare(`
      INSERT INTO embeddings (path, content_hash, vector, computed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content_hash=excluded.content_hash, vector=excluded.vector, computed_at=excluded.computed_at
    `).run(row.path, hash, vec, Math.floor(Date.now() / 1000));
    embedded++;
  }

  // Pairwise similarity across ALL embeddings (including unchanged ones — re-inserts edges after rebuild)
  const allEmbs = d.prepare(`SELECT path, vector FROM embeddings`).all();
  const vecList = allEmbs.map(r => {
    const buf = r.vector; // Uint8Array/Buffer from bun:sqlite
    return { path: r.path, vec: new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)) };
  });

  // Phase 1: per-note top-K nomination with threshold filter.
  // Union rule: edge(A,B) exists if A nominates B OR B nominates A.
  const topNeighbors = new Map(); // path → [{sim, path: neighborPath}]
  const histogram = dryRun
    ? { '0.5-0.6': 0, '0.6-0.7': 0, '0.7-0.8': 0, '0.8-0.9': 0, '0.9-0.95': 0, '0.95-1.0': 0 }
    : null;

  for (let i = 0; i < vecList.length; i++) {
    const { path: pi, vec: vi } = vecList[i];
    const eligible = [];
    for (let j = 0; j < vecList.length; j++) {
      if (i === j) continue;
      const sim = _cosine(vi, vecList[j].vec);
      // Histogram counts each undirected pair once (i < j), cosine ≥ 0.5
      if (histogram && j > i && sim >= 0.5) {
        if (sim < 0.6)       histogram['0.5-0.6']++;
        else if (sim < 0.7)  histogram['0.6-0.7']++;
        else if (sim < 0.8)  histogram['0.7-0.8']++;
        else if (sim < 0.9)  histogram['0.8-0.9']++;
        else if (sim < 0.95) histogram['0.9-0.95']++;
        else                 histogram['0.95-1.0']++;
      }
      if (sim >= threshold) eligible.push({ sim, path: vecList[j].path });
    }
    eligible.sort((a, b) => b.sim - a.sim);
    topNeighbors.set(pi, topK > 0 ? eligible.slice(0, topK) : eligible);
  }

  // Phase 2: build union set of canonical edge keys ("pathA\x00pathB", pathA < pathB)
  const nominations = new Set();
  for (const [pi, neighbors] of topNeighbors) {
    for (const { path: pj } of neighbors) {
      const key = pi < pj ? `${pi}\x00${pj}` : `${pj}\x00${pi}`;
      nominations.add(key);
    }
  }

  let semantic_links_added = 0, semantic_links_skipped_existing = 0;

  if (dryRun) {
    for (const key of nominations) {
      const sep = key.indexOf('\x00');
      const path_a = key.slice(0, sep);
      const path_b = key.slice(sep + 1);
      const target_b = path_b.replace(/^.*\//, '').replace(/\.md$/, '');
      const target_a = path_a.replace(/^.*\//, '').replace(/\.md$/, '');
      const exists = d.prepare(`
        SELECT 1 FROM links
        WHERE (source=? AND target=?) OR (source=? AND target=?)
           OR (source=? AND target=?) OR (source=? AND target=?)
        LIMIT 1
      `).get(path_a, target_b, path_b, target_a, path_a, path_b, path_b, path_a);
      if (exists) semantic_links_skipped_existing++;
      else semantic_links_added++;
    }
    return {
      dry_run: true,
      histogram,
      edges_would_insert: semantic_links_added,
      embedded,
      skipped_hash,
      semantic_links_skipped_existing,
    };
  }

  // Phase 3: insert nominated edges
  for (const key of nominations) {
    const sep = key.indexOf('\x00');
    const path_a = key.slice(0, sep);
    const path_b = key.slice(sep + 1);
    const target_b = path_b.replace(/^.*\//, '').replace(/\.md$/, '');
    const target_a = path_a.replace(/^.*\//, '').replace(/\.md$/, '');
    const exists = d.prepare(`
      SELECT 1 FROM links
      WHERE (source=? AND target=?) OR (source=? AND target=?)
         OR (source=? AND target=?) OR (source=? AND target=?)
      LIMIT 1
    `).get(path_a, target_b, path_b, target_a, path_a, path_b, path_b, path_a);
    if (exists) { semantic_links_skipped_existing++; continue; }
    d.prepare(`INSERT OR IGNORE INTO links (source,target,kind,confidence) VALUES (?,?,'semantic','INFERRED')`).run(path_a, target_b);
    semantic_links_added++;
  }

  return { embedded, skipped_hash, semantic_links_added, semantic_links_skipped_existing };
}

// ── Direct invocation smoke test ─────────────────────────────────────────────
if (require.main === module) {
  console.log('vault.js self-test — VAULT_ROOT:', vaultRoot());
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


module.exports = { vaultRoot, parseFrontmatter, serializeFrontmatter, writeNote, readNote, rebuildIndex, deleteNote, previewDeleteNote, pruneFixtures, _upsertIndex, writeSynthesisNote, writeSessionNote, writeLesson, indexPlanFile, searchNotes, backlinks, DISMISSED_STATUSES, listDue, listUnresolved, neighbors, shortestPath, listHubs, listGaps, setWorkerVerdict, withNoteLock, setStatus, setDueDate, backfillVerdicts, retroLink, computeCommunities, listCommunities, embedNotes };