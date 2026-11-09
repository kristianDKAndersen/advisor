'use strict';
// Worker pane placement, tagging and token-checked close in the user's live herdr session.
// Pane ids are reused across sessions, so a pane is closed only when its advisor_sid token matches.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TAB_PANE_CAP = 6;
const TAB_LABEL = 'advisor';
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 60000;
const SID_TOKEN_MAX = 80;
const REAP_MIN_SID_AGE_MS = 2 * 3600 * 1000;
const REAP_MIN_SESSION_AGE_MS = 24 * 3600 * 1000;

// Allow-list: any other method (tab/workspace/server/session teardown included) is refused here.
const ALLOWED_METHODS = new Set([
  'pane.get', 'pane.list', 'tab.list', 'tab.create', 'pane.split', 'pane.close',
  'pane.report_metadata', 'pane.read', 'pane.send_text', 'pane.send_keys',
  'events.subscribe', 'workspace.list', 'ping',
]);

function call(client, method, params) {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`herdr-method-not-allowed: ${method}`);
  return client.request(method, params);
}

const sidToken = (sid) => (typeof sid === 'string' ? sid.slice(0, SID_TOKEN_MAX) : '');
const isNotFound = (err) => !!err && err.code === 'pane_not_found';
const paneOf = (res) => (res && res.pane) || res || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paneState(client, paneId) {
  try {
    await call(client, 'pane.get', { pane_id: paneId });
    return 'alive';
  } catch (err) {
    return isNotFound(err) ? 'gone' : 'unknown';
  }
}

async function tagPane(client, paneId, sid) {
  const want = sidToken(sid);
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await call(client, 'pane.report_metadata', { pane_id: paneId, source: 'advisor', tokens: { advisor_sid: want } });
      const pane = paneOf(await call(client, 'pane.get', { pane_id: paneId }));
      if (pane.tokens && pane.tokens.advisor_sid === want) return;
      last = new Error('tag-verify-failed');
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

// ── placement ────────────────────────────────────────────────────────────────

async function withLock(lockDir, fn) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (_) { continue; }
      if (age > LOCK_STALE_MS) {
        try { fs.rmdirSync(lockDir); } catch (_) { /* another process reclaimed it */ }
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('herdr-lock-timeout');
      await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch (_) { /* already reclaimed as stale */ }
  }
}

async function resolveWorkspace(client, env) {
  if (env && env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  if (env && env.HERDR_PANE_ID) {
    try {
      const ws = paneOf(await call(client, 'pane.get', { pane_id: env.HERDR_PANE_ID })).workspace_id;
      if (ws) return ws;
    } catch (_) { /* fall through to the error below */ }
  }
  const err = new Error('HERDR_NO_WORKSPACE: set HERDR_WORKSPACE_ID or run inside a herdr pane');
  err.code = 'HERDR_NO_WORKSPACE';
  throw err;
}

const panesInTab = async (client, tabId) =>
  (((await call(client, 'pane.list', {})) || {}).panes || []).filter((p) => p.tab_id === tabId);

// Odd count -> the next pane goes right, even -> down.
const nextDirection = (count) => (count % 2 === 1 ? 'right' : 'down');

async function createTab(client, workspaceId, label, cwd) {
  const res = await call(client, 'tab.create', { workspace_id: workspaceId, label, cwd, focus: false });
  const tab = (res && res.tab) || {};
  // Schema 0.9.5 returns root_pane; fall back to pane.list in case a build omits it.
  const rootId = (res && res.root_pane && res.root_pane.pane_id) || ((await panesInTab(client, tab.tab_id))[0] || {}).pane_id;
  if (!rootId) throw new Error('herdr-tab-create-no-root-pane');
  return { tabId: tab.tab_id, paneId: rootId };
}

async function splitLast(client, tabPanes, cwd) {
  const res = await call(client, 'pane.split', {
    target_pane_id: tabPanes[tabPanes.length - 1].pane_id,
    direction: nextDirection(tabPanes.length),
    ratio: 0.5,
    cwd,
    focus: false,
  });
  return paneOf(res).pane_id;
}

async function ensureWorkerPane({ client, env, sid, agent, lockDir, cwd }) {
  const workspaceId = await resolveWorkspace(client, env);
  return withLock(lockDir, async () => {
    const tabs = ((await call(client, 'tab.list', { workspace_id: workspaceId })) || {}).tabs || [];
    for (let n = 1; ; n++) {
      const label = n === 1 ? TAB_LABEL : `${TAB_LABEL}-${n}`;
      const tab = tabs.find((t) => t.label === label && (!t.workspace_id || t.workspace_id === workspaceId));
      if (!tab) {
        const created = await createTab(client, workspaceId, label, cwd);
        return { paneId: created.paneId, tabId: created.tabId, workspaceId };
      }
      const existing = await panesInTab(client, tab.tab_id);
      if (existing.length >= TAB_PANE_CAP) continue;
      if (existing.length === 0) {
        const created = await createTab(client, workspaceId, label, cwd);
        return { paneId: created.paneId, tabId: created.tabId, workspaceId };
      }
      const paneId = await splitLast(client, existing, cwd);
      return { paneId, tabId: tab.tab_id, workspaceId };
    }
  });
}

async function allocateEnsemblePanes({ client, env, sids, lockDir, cwd, dateStamp }) {
  const workspaceId = await resolveWorkspace(client, env);
  if (!sids || sids.length === 0) return [];
  const stamp = dateStamp || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return withLock(lockDir, async () => {
    const created = await createTab(client, workspaceId, `ensemble-${sids.length}-${stamp}`, cwd);
    const panes = [{ pane_id: created.paneId }];
    while (panes.length < sids.length) {
      panes.push({ pane_id: await splitLast(client, panes, cwd) });
    }
    return sids.map((sid, i) => ({ sid, paneId: panes[i].pane_id, tabId: created.tabId, workspaceId }));
  });
}

// ── token-checked close ──────────────────────────────────────────────────────

function readRunnerRecord(runDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(runDir, 'runner.json'), 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch (_) {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function closePaneChecked({ client, sid, paneId, runDir, runnerAlive }) {
  const want = sidToken(sid);
  let pane;
  try {
    pane = paneOf(await call(client, 'pane.get', { pane_id: paneId }));
  } catch (err) {
    return { closed: false, reason: isNotFound(err) ? 'gone' : 'unavailable' };
  }
  const have = pane.tokens && pane.tokens.advisor_sid;
  if (!want) return { closed: false, reason: 'token-mismatch' };
  if (have === undefined || have === null || have === '') {
    // Untokened (e.g. after a herdr restart): only the runner's own record plus a live runner vouches for it.
    const rec = readRunnerRecord(runDir);
    if (!(runnerAlive === true && rec && rec.pane_id === paneId)) return { closed: false, reason: 'untokened-refused' };
  } else if (have !== want) {
    return { closed: false, reason: 'token-mismatch' };
  }
  try {
    await call(client, 'pane.close', { pane_id: paneId });
    return { closed: true, reason: 'closed' };
  } catch (err) {
    return { closed: false, reason: isNotFound(err) ? 'gone' : 'unavailable' };
  }
}

async function closeWorkerBySid({ client, sid, runDir }) {
  const want = sidToken(sid);
  const rec = readRunnerRecord(runDir);
  const runnerAlive = !!rec && pidAlive(rec.pid);
  const candidates = [];
  if (rec && typeof rec.pane_id === 'string' && rec.pane_id) candidates.push(rec.pane_id);
  const refused = [];
  try {
    const list = (await call(client, 'pane.list', {})) || {};
    for (const p of list.panes || []) {
      if (want && p.tokens && p.tokens.advisor_sid === want && !candidates.includes(p.pane_id)) candidates.push(p.pane_id);
    }
  } catch (_) {
    refused.push({ paneId: 'pane.list', reason: 'unavailable' });
  }
  const closed = [];
  for (const paneId of candidates) {
    const r = await closePaneChecked({ client, sid, paneId, runDir, runnerAlive });
    if (r.closed) closed.push(paneId);
    else if (r.reason !== 'gone') refused.push({ paneId, reason: r.reason });
  }
  return { closed, refused };
}

function runsRoot(env) {
  return (env && env.ADVISOR_RUNS_ROOT) || path.join(os.homedir(), '.advisor', 'runs');
}

async function closeSelf({ client, env }) {
  const paneId = env && env.HERDR_PANE_ID;
  const sid = env && env.ADVISOR_SID;
  if (!paneId || !sid || path.basename(sid) !== sid) return { closed: false, reason: 'no-env' };
  const runDir = path.join(runsRoot(env), sid);
  const rec = readRunnerRecord(runDir);
  return closePaneChecked({ client, sid, paneId, runDir, runnerAlive: !!rec && pidAlive(rec.pid) });
}

// ── reaper and probe ─────────────────────────────────────────────────────────

// Default pgrep: true when a process mentions the sid; any failure to ask counts as "found" (skip).
function defaultPgrep(sid) {
  const r = spawnSync('pgrep', ['-f', sid], { stdio: 'ignore' });
  return r.status !== 1;
}

async function reapOrphanHerdrPanes({ client, runsDir, now = Date.now(), pgrep = defaultPgrep }) {
  let panes;
  try {
    panes = ((await call(client, 'pane.list', {})) || {}).panes || [];
  } catch (_) {
    return [];
  }
  const reaped = [];
  for (const pane of panes) {
    const sid = pane.tokens && pane.tokens.advisor_sid;
    if (typeof sid !== 'string' || !sid || path.basename(sid) !== sid || sid === '.' || sid === '..') continue;
    const ts = /^(\d{9,})-/.exec(sid);
    if (!ts || now - Number(ts[1]) * 1000 < REAP_MIN_SID_AGE_MS) continue;
    const runDir = path.join(runsDir, sid);
    let mtimeMs;
    try { mtimeMs = fs.statSync(path.join(runDir, 'session.json')).mtimeMs; } catch (_) { continue; }
    if (now - mtimeMs < REAP_MIN_SESSION_AGE_MS) continue;
    if (await pgrep(sid)) continue;
    const r = await closePaneChecked({ client, sid, paneId: pane.pane_id, runDir, runnerAlive: false });
    if (r.closed) reaped.push(pane.pane_id);
  }
  return reaped;
}

async function probeRunnerPane({ client, runDir }) {
  const rec = readRunnerRecord(runDir);
  if (!rec || typeof rec.pane_id !== 'string' || !rec.pane_id) return 'no-record';
  return paneState(client, rec.pane_id);
}

module.exports = {
  TAB_PANE_CAP,
  TAB_LABEL,
  paneState,
  tagPane,
  ensureWorkerPane,
  allocateEnsemblePanes,
  closePaneChecked,
  closeWorkerBySid,
  closeSelf,
  reapOrphanHerdrPanes,
  probeRunnerPane,
};
