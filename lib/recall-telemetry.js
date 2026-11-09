'use strict';
// Append-only log of which lessons were injected into which worker brief,
// joined lazily to the worker's final verdict. Every function fails open.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_LINE_BYTES = 4000;

function recallPath() {
  const { vaultRoot } = require('./vault');
  return path.join(vaultRoot(), '.cache', 'recall.jsonl');
}

// channel.js does not export runsRoot(); mirrored here.
function runsRoot() {
  if (process.env.ADVISOR_RUNS_ROOT) return process.env.ADVISOR_RUNS_ROOT;
  return path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.advisor', 'runs');
}

function hashQuery(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 16);
}

function appendRecall({ sid, agent, queryHash, lessons, notes } = {}) {
  try {
    const row = {
      v: 1,
      ts: Math.floor(Date.now() / 1000),
      sid: sid || '',
      agent: agent || '',
      query_hash: queryHash || '',
      lessons: (Array.isArray(lessons) ? lessons : []).map(l => ({
        path: l.path, rank: l.rank, routing_hits: l.routing_hits, score: l.score,
      })),
      notes: Array.isArray(notes) ? notes.slice() : [],
    };
    const size = () => Buffer.byteLength(JSON.stringify(row) + '\n');
    while (size() > MAX_LINE_BYTES && row.notes.length) row.notes.pop();
    while (size() > MAX_LINE_BYTES && row.lessons.length) row.lessons.pop();
    const p = recallPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
  } catch (_) { /* fail open */ }
}

function readRecalls() {
  let raw;
  try { raw = fs.readFileSync(recallPath(), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

function verdictForSid(sid) {
  try {
    const { parseEnvelope } = require('./channel');
    const file = path.join(runsRoot(), sid, 'channel', 'outbox.jsonl');
    let best = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m && m.type === 'result' && typeof m.seq === 'number' && (!best || m.seq >= best.seq)) best = m;
    }
    const v = best && parseEnvelope(best.body);
    return v && typeof v.verdict === 'string' ? v.verdict : 'pending';
  } catch (_) {
    return 'pending';
  }
}

function lessonStats({ now } = {}) {
  const cutoff = typeof now === 'number' ? now : Infinity;
  const rows = readRecalls().filter(r => typeof r.ts !== 'number' || r.ts <= cutoff);
  const verdicts = new Map();
  const verdict = sid => {
    if (!verdicts.has(sid)) verdicts.set(sid, verdictForSid(sid));
    return verdicts.get(sid);
  };
  const per = {};
  const baseSids = new Set();
  for (const r of rows) {
    const ls = Array.isArray(r.lessons) ? r.lessons : [];
    if (ls.length === 0) { baseSids.add(r.sid); continue; }
    for (const l of ls) {
      const s = per[l.path] || (per[l.path] = { recall_count: 0, last_recalled: 0, sids: new Set() });
      s.recall_count++;
      if (typeof r.ts === 'number' && r.ts > s.last_recalled) s.last_recalled = r.ts;
      s.sids.add(r.sid);
    }
  }
  const rate = sids => {
    let n = 0, ok = 0;
    for (const sid of sids) {
      const v = verdict(sid);
      if (v === 'pending') continue;
      n++;
      if (v === 'complete') ok++;
    }
    return { n, rate: n ? ok / n : null };
  };
  const lessons = {};
  for (const [p, s] of Object.entries(per)) {
    const { n, rate: r } = rate(s.sids);
    lessons[p] = { recall_count: s.recall_count, last_recalled: s.last_recalled, success_after_recall: r, n };
  }
  const b = rate(baseSids);
  return { lessons, baseline: { n: b.n, success_rate: b.rate } };
}

module.exports = { appendRecall, readRecalls, verdictForSid, lessonStats, hashQuery };
