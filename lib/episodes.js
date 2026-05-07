// lib/episodes.js — episodic log for advisor memory.
// Writes/reads ~/.advisor/memory/episodes.jsonl (HOME overridable for tests).

import fs from 'fs';
import path from 'path';

function episodesPath() {
  return path.join(process.env.HOME, '.advisor', 'memory', 'episodes.jsonl');
}

export function writeEpisode(record) {
  const p = episodesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify({
    sid: record.sid,
    task_hash: record.task_hash,
    ts: record.ts,
    established: record.established,
    gap: record.gap,
    key_quotes: record.key_quotes
  });
  fs.appendFileSync(p, line + '\n');
}

export function queryEpisodes(task_hash, limit) {
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
  return results.slice(0, limit);
}
