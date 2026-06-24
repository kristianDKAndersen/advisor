// lib/episodes.js — episodic log for advisor memory.
// Writes/reads ~/.advisor/memory/episodes.jsonl (HOME overridable for tests).

const fs = require('fs');
const path = require('path');

function episodesPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.advisor', 'memory', 'episodes.jsonl');
}

function writeEpisode(record) {
  const p = episodesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = {
    sid: record.sid,
    task_hash: record.task_hash,
    ts: record.ts,
    established: record.established,
    gap: record.gap,
    key_quotes: record.key_quotes
  };
  if (record.goal !== undefined) entry.goal = record.goal;
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  if (record.goal && record.sid) {
    try {
      const vault = require('./vault.js');
      vault.indexEpisodeGoal(record.sid, record.goal);
    } catch (_) {}
  }
}

function queryEpisodes(task_hash, limit) {
  const p = episodesPath();
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8').trim();
  if (!content) return [];
  const results = [];
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry.task_hash === task_hash) results.push(entry);
    } catch (_) {}
  }
  return results.slice(-limit);
}

function queryEpisodesFuzzy(goalText, limit) {
  let matchingSids;
  try {
    const vault = require('./vault.js');
    matchingSids = vault.searchEpisodeGoals(goalText, limit);
  } catch (_) { return []; }
  if (!matchingSids || !matchingSids.length) return [];

  const p = episodesPath();
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8').trim();
  if (!content) return [];

  const sidSet = new Set(matchingSids);
  const byScore = new Map(matchingSids.map((sid, i) => [sid, i]));
  const results = [];
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (sidSet.has(entry.sid)) results.push(entry);
    } catch (_) {}
  }
  results.sort((a, b) => (byScore.get(a.sid) ?? 999) - (byScore.get(b.sid) ?? 999));
  return results.slice(0, limit);
}

module.exports = { writeEpisode, queryEpisodes, queryEpisodesFuzzy };
