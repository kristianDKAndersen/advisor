'use strict';
// Drafts lessons as status: proposed; a human or the Advisor fills "## Heuristic" and
// approves. Runtime: Bun (via lib/vault.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const vault = require('./vault.js');

const DAY_MS = 86400000;
const CAP = 400;
const BLOCKED_SCAN_DAYS = 7;
const STOPWORDS = new Set((
  'the a an and or but if then else of to in on at by for with from as is are was were be been being it its this that ' +
  'these those not no do does did done has have had will would should could can may might must we you your i they ' +
  'them their our us he she his her so than too very just into out up down over under again also all any each more ' +
  'most some such only own same about after before between through during what which who whom when where why how'
).split(/\s+/));

function runsRoot() {
  if (process.env.ADVISOR_RUNS_ROOT) return process.env.ADVISOR_RUNS_ROOT;
  return path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.advisor', 'runs');
}

const sha256 = s => createHash('sha256').update(s).digest('hex');
const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cap = s => oneLine(s).slice(0, CAP);

function tokens(text) {
  const out = [];
  for (const t of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= 3 && !STOPWORDS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const t of a) if (sb.has(t)) inter++;
  return inter / (a.length + b.length - inter);
}

// Greedy: an item joins the first cluster whose seed (first member) is >= 0.5 similar.
function cluster(items) {
  const clusters = [];
  for (const it of items) {
    const home = clusters.find(c => jaccard(c[0].tok, it.tok) >= 0.5);
    if (home) home.push(it); else clusters.push([it]);
  }
  return clusters;
}

function topTokens(texts, n = 5) {
  const freq = new Map();
  for (const text of texts) for (const t of tokens(text)) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]).join(' ');
}

function existingKeys() {
  const keys = new Map();
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        try {
          const { fm } = vault.parseFrontmatter(fs.readFileSync(p, 'utf8'));
          if (fm.capture_key) keys.set(fm.capture_key, path.relative(vault.vaultRoot(), p).split(path.sep).join('/'));
        } catch (_) {}
      }
    }
  };
  walk(path.join(vault.vaultRoot(), 'lessons'));
  return keys;
}

function section(body, name) {
  const m = body.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |\\s*$)`));
  return m ? m[1].trim() : '';
}

function listSynthesis(sinceDays, now) {
  const dir = path.join(vault.vaultRoot(), 'synthesis');
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch (_) { return []; }
  const cutoff = now - sinceDays * DAY_MS;
  const out = [];
  for (const f of files) {
    try {
      const { fm, body } = vault.parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      const created = Date.parse(fm.created_at);
      if (!(created >= cutoff)) continue;
      out.push({
        rel: `synthesis/${f}`, name: f.replace(/\.md$/, ''), sid: fm.sid || '', created,
        established: section(body, 'Established') || fm.established || '',
        gap: section(body, 'Gap') || fm.gap || '', next: fm.next_action || '',
      });
    } catch (_) {}
  }
  return out.sort((a, b) => a.created - b.created || (a.rel < b.rel ? -1 : 1));
}

// writeLesson derives the file name from sid-agent-seq, so the proposed-<date>-<source>-<key8>
// name is passed through those fields and the real sid is restored (with audience) afterwards.
function draft(state, { source, key, sid, audience, taskType, body, members }) {
  const skip = at => { state.skipped.push({ capture_key: key, source, reason: 'exists', path: at }); };
  if (state.keys.has(key)) return skip(state.keys.get(key));
  const day = new Date(state.now).toISOString().slice(0, 10).replace(/-/g, '');
  const rel = `lessons/proposed-${day}-${source}-${key.slice(0, 8)}.md`;
  state.keys.set(key, rel);
  if (!state.dryRun) {
    // Per-key lock: concurrent captures re-check under it, so only the first one writes.
    const prior = vault.withNoteLock(`capture-${key}`, () => {
      const seen = existingKeys().get(key);
      if (seen) return seen;
      try {
        vault.writeLesson({
          sid: `proposed-${day}`, agent: source, synthesis_seq: key.slice(0, 8),
          task_type: oneLine(taskType), failure_mode: '', evaluator_dim: `capture:${source}`,
          status: 'proposed', source, capture_key: key, body,
          ts: state.now / 1000, ts_iso: new Date(state.now).toISOString(),
        });
      } catch (err) {
        if (err && err.code === 'LESSON_EXISTS') return rel;
        throw err;
      }
      const note = vault.readNote(rel);
      note.fm.sid = oneLine(sid);
      if (audience) note.fm.audience = audience;
      vault.writeNote(rel, note.fm, note.body.replace(/^\n/, ''));
      return null;
    });
    if (prior) { state.keys.set(key, prior); return skip(prior); }
  }
  state.proposed.push({ capture_key: key, path: rel, source, members });
}

const newState = ({ dryRun = false, now = Date.now() } = {}) =>
  ({ dryRun, now, keys: existingKeys(), proposed: [], skipped: [] });
const result = s => ({ proposed: s.proposed, skipped: s.skipped });
const lessonBody = (observed, evidence) =>
  `## Observed gap\n${observed}\n\n## Heuristic\n\n## Evidence\n${evidence}\n`;

function captureReturnRounds({ sinceDays = 30, dryRun, now } = {}) {
  const st = newState({ dryRun, now });
  for (const n of listSynthesis(sinceDays, st.now)) {
    if (!n.next.toLowerCase().includes('spawn-refinement')) continue;
    draft(st, {
      source: 'return', key: sha256('return:' + n.rel), sid: n.sid,
      taskType: topTokens([n.established]),
      body: lessonBody(`Gap: ${cap(n.gap)}\n\nNext action: ${cap(n.next)}`, `[[${n.name}]]`),
      members: [n.rel],
    });
  }
  return result(st);
}

function captureCorrections({ minCount = 2, dryRun, now } = {}) {
  const st = newState({ dryRun, now });
  let lines = [];
  try { lines = fs.readFileSync(path.join(vault.vaultRoot(), '.cache', 'corrections.jsonl'), 'utf8').split('\n'); } catch (_) {}
  const items = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e && e.target === 'advisor' && typeof e.text === 'string') items.push({ e, tok: tokens(e.text) });
    } catch (_) {}
  }
  for (const c of cluster(items)) {
    if (c.length < minCount) continue;
    const seed = c[0].e;
    const pats = c.map(m => oneLine(m.e.matched_pattern));
    const common = [...new Set(pats)].sort((a, b) => pats.filter(p => p === b).length - pats.filter(p => p === a).length)[0];
    const rows = c.map(m => `- ts: ${m.e.ts}, sid: ${oneLine(m.e.sid)}, matched_pattern: ${oneLine(m.e.matched_pattern)}`);
    draft(st, {
      source: 'corrections', key: sha256(`corrections:${seed.ts}:${seed.sid}`), sid: seed.sid,
      audience: 'advisor', taskType: common,
      body: lessonBody(`${c.length} similar user corrections of the Advisor (text not retained):\n${rows.join('\n')}`,
        'Source: .cache/corrections.jsonl'),
      members: c.map(m => `${oneLine(m.e.sid)}@${m.e.ts}`),
    });
  }
  return result(st);
}

function captureGapClusters({ sinceDays = 30, minSize = 3, minSessions = 2, dryRun, now } = {}) {
  const st = newState({ dryRun, now });
  const items = listSynthesis(sinceDays, st.now)
    .filter(n => n.gap && oneLine(n.gap).toLowerCase() !== 'none')
    .map(n => ({ n, tok: tokens(n.gap) }));
  for (const c of cluster(items)) {
    const sids = new Set(c.map(m => m.n.sid));
    if (c.length < minSize || sids.size < minSessions) continue;
    const seed = c[0].n;
    draft(st, {
      source: 'gaps', key: sha256('gap:' + seed.rel), sid: seed.sid,
      taskType: topTokens(c.map(m => m.n.gap)),
      body: lessonBody(`${c.length} synthesis notes across ${sids.size} sessions report a similar gap.\n\nExample: ${cap(seed.gap)}`,
        c.map(m => `[[${m.n.name}]]`).join(' ')),
      members: c.map(m => m.n.rel),
    });
  }
  return result(st);
}

function advisorSessionOf(sid) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runsRoot(), sid, 'meta.json'), 'utf8'));
    return typeof meta.advisor_session === 'string' && meta.advisor_session ? meta.advisor_session : null;
  } catch (_) { return null; }
}

// Blocked result verdicts across runs of one Advisor session; runs older than
// BLOCKED_SCAN_DAYS (by sid epoch prefix) are not scanned.
function blockedWorkers(advisorSession, now = Date.now()) {
  if (!advisorSession) return [];
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(runsRoot()).sort(); } catch (_) {}
  for (const sid of dirs) {
    const m = sid.match(/^(\d{9,11})-/);
    if (!m || Number(m[1]) * 1000 < now - BLOCKED_SCAN_DAYS * DAY_MS) continue;
    if (advisorSessionOf(sid) !== advisorSession) continue;
    let lines = [];
    try { lines = fs.readFileSync(path.join(runsRoot(), sid, 'channel', 'outbox.jsonl'), 'utf8').split('\n'); } catch (_) {}
    for (const l of lines) {
      try {
        const msg = JSON.parse(l);
        if (msg.type !== 'result') continue;
        const env = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
        if (env && env.verdict === 'blocked') out.push({ sid, seq: msg.seq });
      } catch (_) {}
    }
  }
  return out;
}

function captureBlockedChain({ advisorSession, workerSid, dryRun, now } = {}) {
  const st = newState({ dryRun, now });
  const members = blockedWorkers(advisorSession, st.now);
  if (members.length < 2) return result(st);
  draft(st, {
    source: 'blocked', key: sha256('blocked:' + advisorSession), sid: workerSid || members[members.length - 1].sid,
    audience: 'advisor', taskType: 'blocked-chain',
    body: lessonBody(`${members.length} blocked worker verdicts in one Advisor session:\n` +
      members.map(x => `- worker ${x.sid}, result seq ${x.seq}`).join('\n'),
      members.map(x => `[[${x.sid}]]`).join(' ')),
    members: members.map(x => `${x.sid}#${x.seq}`),
  });
  return result(st);
}

module.exports = {
  captureReturnRounds, captureCorrections, captureGapClusters, captureBlockedChain,
  blockedWorkers, advisorSessionOf, runsRoot,
};
