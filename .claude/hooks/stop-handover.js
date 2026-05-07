#!/usr/bin/env node
// Stop hook: write handover-snapshot.json to ~/.advisor/runs/<session_id>/ for session continuity.

const fs = require('fs');
const path = require('path');

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try { event = JSON.parse(raw); } catch { return; }

  const { session_id: sid } = event || {};
  if (!sid) return;

  const home = process.env.HOME || require('os').homedir();
  const runDir = path.join(home, '.advisor', 'runs', sid);
  const sessionPath = path.join(runDir, 'session.json');
  const snapshotPath = path.join(runDir, 'handover-snapshot.json');

  let next_action = '';
  let memory_blocks = null;

  try {
    const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    next_action = typeof sessionData.next_action === 'string' ? sessionData.next_action : '';
    memory_blocks = sessionData.memory_blocks !== undefined ? sessionData.memory_blocks : null;
  } catch { /* missing or invalid session.json — use fallback */ }

  const now = Date.now();
  const snapshot = {
    sid,
    ts: now,
    next_action,
    memory_blocks,
    last_modified_at: now,
  };

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
}

main().catch(() => {});
