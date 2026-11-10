'use strict';
// Recall for task briefs: a lesson lane (routing-gated, no decay) and a notes lane.
const fs = require('fs');
const path = require('path');
const { Database } = require('bun:sqlite');

const LESSON_MIN_ROUTING_HITS = 2;
const LESSON_POOL = 30;
const HEURISTIC_CAP = 600;
const ROUTING_COVERAGE_CAP = 5;
const NOTE_TYPES = ['synthesis', 'project', 'plan'];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
  'her', 'was', 'one', 'our', 'out', 'has', 'him', 'his', 'how', 'now',
  'see', 'two', 'way', 'who', 'did', 'its', 'let', 'put', 'say', 'she',
  'too', 'use', 'with', 'this', 'that', 'from', 'have', 'been', 'were',
  'they', 'their', 'what', 'when', 'where', 'which', 'will', 'would',
  'there', 'about', 'into', 'than', 'then', 'also', 'need', 'each'
]);

const QUERY_TOKEN_CAP = 20;

// Order matters: tags first, then URLs, then any slash-bearing word (paths, branch names).
function stripNoise(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S*\/\S*/g, ' ')
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, ' ')
    .replace(/\b\d{8,}-[0-9a-f]{6,}\b/gi, ' ')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, ' ');
}

function queryTokens(taskText, cap = QUERY_TOKEN_CAP) {
  const tokens = stripNoise(taskText || '').match(/[a-zA-Z0-9]+/g) || [];
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (t.length < 3 || STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, cap);
}

function sanitizeRecallQuery(taskText) {
  return queryTokens(taskText).join(' OR ');
}

// Default 0 (floor off): bm25 relevance is corpus-dependent and zeroes out on small vaults.
function noteMinRelevance() {
  const raw = process.env.ADVISOR_VAULT_RECALL_MIN_RELEVANCE;
  const parsed = (raw === undefined || raw === '') ? 0 : parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Matches `## Heuristic` / `## Heuristics`, optionally followed by a space, `(` or `/` suffix.
function heuristicSection(body) {
  const re = /^## Heuristics?(?:[ (\/][^\n]*)?(?:\n|(?![\s\S]))([\s\S]*?)(?=^## |(?![\s\S]))/gm;
  const parts = [];
  for (const m of body.matchAll(re)) {
    const text = m[1].trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function heuristicOf(body) {
  const section = heuristicSection(body);
  return section.replace(/\s+/g, ' ').slice(0, HEURISTIC_CAP);
}

function lessonPool(vault, query) {
  const dbFile = path.join(vault.vaultRoot(), '.cache', 'vault.db');
  if (!fs.existsSync(dbFile)) return [];
  const d = new Database(dbFile, { readonly: true });
  try {
    return d.prepare(`
      SELECT n.path, n.routing, bm25(notes_fts) AS bm25raw
      FROM notes_fts f JOIN notes n ON n.path = f.path
      WHERE notes_fts MATCH ?
        AND n.type = 'lesson' AND n.superseded_by IS NULL
        AND (n.status IS NULL OR n.status IN ('', 'active', 'stale'))
      ORDER BY rank LIMIT ?
    `).all(query, LESSON_POOL);
  } finally {
    d.close();
  }
}

// Scores the lesson pool, then keeps lessons whose audience is in the allowlist.
function lessonLane(taskText, limit, allowedAudiences) {
  const tokens = [...new Set(queryTokens(taskText).map(t => t.toLowerCase()))];
  if (!tokens.length || limit <= 0) return [];
  const vault = require('./vault');
  let rows;
  try {
    rows = lessonPool(vault, tokens.map(t => `"${t}"`).join(' OR '));
  } catch (e) {
    console.error(`[vault] lesson recall failed: ${e && e.message}`);
    return []; // keep the notes lane alive if the read-only handle cannot open
  }
  if (!rows.length) return [];
  const bm = rows.map(r => r.bm25raw);
  const maxBm = Math.max(...bm), range = maxBm - Math.min(...bm);
  const denom = Math.min(tokens.length, ROUTING_COVERAGE_CAP);
  const scored = [];
  for (const r of rows) {
    const routing = new Set((r.routing || '').toLowerCase().match(/[a-z0-9]+/g) || []);
    const routingHits = tokens.filter(t => routing.has(t)).length;
    if (routingHits < LESSON_MIN_ROUTING_HITS) continue;
    const note = vault.readNote(r.path);
    if (!note) continue;
    const audience = String(note.fm.audience || 'both').trim().toLowerCase();
    if (!allowedAudiences.includes(audience)) continue;
    const heuristic = heuristicOf(note.body);
    if (!heuristic) continue;
    const bm25norm = range > 0 ? (maxBm - r.bm25raw) / range : 1;
    const score = 0.6 * bm25norm + 0.4 * Math.min(1, routingHits / denom);
    const name = r.path.replace(/^.*\//, '').replace(/\.md$/, '');
    scored.push({
      path: r.path,
      absPath: path.join(vault.vaultRoot(), r.path),
      name,
      heuristic,
      routing_hits: routingHits,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return scored.slice(0, limit);
}

function recallForTask(taskText, { lessonLimit = 2, noteLimit = 2 } = {}) {
  const lessons = lessonLane(taskText, lessonLimit, ['worker', 'both']);
  const query = sanitizeRecallQuery(taskText);
  const notes = query && noteLimit > 0
    ? require('./vault').searchNotes(query, noteLimit, { types: NOTE_TYPES, minRelevance: noteMinRelevance() })
    : [];
  return { lessons, notes };
}

function recallLessonsForAdvisor(taskText, { limit = 3 } = {}) {
  return lessonLane(taskText, limit, ['advisor', 'both']);
}

module.exports = { heuristicSection, queryTokens, recallForTask, recallLessonsForAdvisor, sanitizeRecallQuery, LESSON_MIN_ROUTING_HITS };
