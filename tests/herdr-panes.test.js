import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
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
  ALLOWED_METHODS,
  pidAlive,
} from '../lib/herdr-panes.js';

const FORBIDDEN = ['tab.close', 'workspace.close', 'server.stop', 'session.stop'];
const ALLOWED = [
  'pane.get', 'pane.list', 'tab.list', 'tab.create', 'pane.split', 'pane.close',
  'pane.report_metadata', 'pane.read', 'pane.send_text', 'pane.send_keys',
  'events.subscribe', 'workspace.list', 'ping', 'agent.get', 'agent.prompt',
];
const HOUR = 3600 * 1000;

class FakeHerdrError extends Error {
  constructor(code, message) { super(message || code); this.name = 'HerdrError'; this.code = code; }
}
class FakeUnavailable extends Error {
  constructor() { super('socket down'); this.name = 'HerdrUnavailableError'; }
}

// In-memory herdr stand-in. `hooks[method](params, st)` may return a result to short-circuit.
function makeFake({ workspaceId = 'w1', tabs = [], panes = [], delay = false } = {}) {
  const st = {
    calls: [],
    down: false,
    hooks: {},
    counter: 10,
    tabs: tabs.map((t) => ({ workspace_id: workspaceId, ...t })),
    panes: panes.map((p) => ({ workspace_id: workspaceId, tokens: {}, ...p })),
  };
  const find = (id) => st.panes.find((p) => p.pane_id === id);
  const client = {
    async request(method, params = {}) {
      st.calls.push({ method, params });
      if (delay) await new Promise((r) => setImmediate(r));
      if (st.down) throw new FakeUnavailable();
      if (st.hooks[method]) {
        const out = st.hooks[method](params, st);
        if (out !== undefined) return out;
      }
      switch (method) {
        case 'pane.get': {
          const p = find(params.pane_id);
          if (!p) throw new FakeHerdrError('pane_not_found', `pane ${params.pane_id} not found`);
          return { type: 'pane_info', pane: structuredClone(p) };
        }
        case 'pane.list':
          return { type: 'pane_list', panes: structuredClone(st.panes) };
        case 'tab.list':
          return { type: 'tab_list', tabs: structuredClone(st.tabs) };
        case 'tab.create': {
          const n = st.counter++;
          const tab = { tab_id: `${params.workspace_id}:t${n}`, label: params.label, workspace_id: params.workspace_id };
          st.tabs.push(tab);
          st.panes.push({ pane_id: `${params.workspace_id}:p${n}`, tab_id: tab.tab_id, workspace_id: params.workspace_id, tokens: {} });
          return { type: 'tab_created', tab };
        }
        case 'pane.split': {
          const target = find(params.target_pane_id);
          if (!target) throw new FakeHerdrError('pane_not_found');
          const n = st.counter++;
          const pane = { pane_id: `${target.workspace_id}:p${n}`, tab_id: target.tab_id, workspace_id: target.workspace_id, tokens: {} };
          st.panes.push(pane);
          return { type: 'pane_info', pane };
        }
        case 'pane.close': {
          const i = st.panes.findIndex((p) => p.pane_id === params.pane_id);
          if (i < 0) throw new FakeHerdrError('pane_not_found');
          st.panes.splice(i, 1);
          return { type: 'pane_closed', pane_id: params.pane_id };
        }
        case 'pane.report_metadata': {
          const p = find(params.pane_id);
          if (!p) throw new FakeHerdrError('pane_not_found');
          Object.assign(p.tokens, params.tokens);
          return { type: 'ok' };
        }
        default:
          throw new FakeHerdrError('unknown_method', method);
      }
    },
  };
  return { client, st, find, methods: () => st.calls.map((c) => c.method), callsOf: (m) => st.calls.filter((c) => c.method === m) };
}

function assertNoForbidden(calls) {
  for (const c of calls) {
    expect(FORBIDDEN).not.toContain(c.method);
    expect(ALLOWED).toContain(c.method);
  }
}

let tmp;
let fakes;
const savedEnv = {};
const ENV_KEYS = ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_ENV', 'ADVISOR_HERDR', 'ADVISOR_RUNS_ROOT'];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-panes-test-'));
  fakes = [];
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  // Every test must have used a fake whose recorded calls contain no forbidden method.
  expect(fakes.length).toBeGreaterThan(0);
  for (const f of fakes) assertNoForbidden(f.st.calls);
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fake(opts) {
  const f = makeFake(opts);
  fakes.push(f);
  return f;
}

function writeRunner(runDir, rec) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'runner.json'), JSON.stringify(rec));
}

const SID = '1794227570-427049';
const baseArgs = (f, extra = {}) => ({
  client: f.client,
  env: { HERDR_WORKSPACE_ID: 'w1' },
  sid: SID,
  agent: 'coder',
  lockDir: path.join(tmp, 'locks', 'herdr-placement.lock'),
  cwd: '/work/dir',
  ...extra,
});

// ── forbidden-method helper ───────────────────────────────────────────────────

describe('forbidden-method assertion', () => {
  test('helper rejects every forbidden method', () => {
    const f = fake();
    for (const m of FORBIDDEN) expect(() => assertNoForbidden([{ method: m }])).toThrow();
    expect(() => assertNoForbidden([{ method: 'pane.get' }])).not.toThrow();
    expect(f.st.calls).toEqual([]);
  });

  test('allow-list is exactly the contract list, agent.get and agent.prompt included', () => {
    fake();
    expect([...ALLOWED_METHODS].sort()).toEqual([...ALLOWED].sort());
    for (const m of FORBIDDEN) expect(ALLOWED_METHODS.has(m)).toBe(false);
  });

  test('module source never names a forbidden method', () => {
    fake();
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'herdr-panes.js'), 'utf8');
    for (const m of FORBIDDEN) expect(src).not.toContain(m);
  });
});

// ── paneState ─────────────────────────────────────────────────────────────────

describe('paneState', () => {
  test('constants', () => {
    fake();
    expect(TAB_PANE_CAP).toBe(6);
    expect(TAB_LABEL).toBe('advisor');
  });

  test('pane.get ok -> alive', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    expect(await paneState(f.client, 'w1:p1')).toBe('alive');
  });

  test('pane_not_found -> gone', async () => {
    const f = fake();
    expect(await paneState(f.client, 'w1:p9')).toBe('gone');
  });

  test('unavailable -> unknown, never gone', async () => {
    const f = fake();
    f.st.down = true;
    expect(await paneState(f.client, 'w1:p1')).toBe('unknown');
  });

  test('any other HerdrError code -> unknown', async () => {
    const f = fake();
    f.st.hooks['pane.get'] = () => { throw new FakeHerdrError('internal_error'); };
    expect(await paneState(f.client, 'w1:p1')).toBe('unknown');
  });
});

// ── tagPane ───────────────────────────────────────────────────────────────────

describe('tagPane', () => {
  test('reports metadata then verifies via pane.get', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    await tagPane(f.client, 'w1:p1', SID);
    expect(f.callsOf('pane.report_metadata')[0].params).toEqual({ pane_id: 'w1:p1', source: 'advisor', tokens: { advisor_sid: SID } });
    expect(f.methods()).toEqual(['pane.report_metadata', 'pane.get']);
  });

  test('retries once when the first verify misses', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    let n = 0;
    f.st.hooks['pane.report_metadata'] = () => (n++ === 0 ? { type: 'ok' } : undefined);
    await tagPane(f.client, 'w1:p1', SID);
    expect(f.callsOf('pane.report_metadata').length).toBe(2);
    expect(f.find('w1:p1').tokens.advisor_sid).toBe(SID);
  });

  test('a HerdrError on every attempt still surfaces as Error("tag-verify-failed") with the cause kept', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    f.st.hooks['pane.report_metadata'] = () => { throw new FakeHerdrError('internal_error'); };
    const err = await tagPane(f.client, 'w1:p1', SID).catch((e) => e);
    expect(err.message).toBe('tag-verify-failed');
    expect(err.code).toBeUndefined();
    expect(err.cause.code).toBe('internal_error');
    expect(f.callsOf('pane.report_metadata').length).toBe(2);
  });

  test('throws tag-verify-failed after the single retry', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    f.st.hooks['pane.report_metadata'] = () => ({ type: 'ok' });
    await expect(tagPane(f.client, 'w1:p1', SID)).rejects.toThrow('tag-verify-failed');
    expect(f.callsOf('pane.report_metadata').length).toBe(2);
  });

  test('a 100-char sid is stored and compared as its first 80 chars', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    const long = 'a'.repeat(100);
    await tagPane(f.client, 'w1:p1', long);
    expect(f.find('w1:p1').tokens.advisor_sid).toBe('a'.repeat(80));
  });
});

// ── ensureWorkerPane ──────────────────────────────────────────────────────────

describe('ensureWorkerPane', () => {
  test('first solo worker creates tab "advisor" with focus:false; root pane is the worker pane', async () => {
    const f = fake();
    const r = await ensureWorkerPane(baseArgs(f));
    const create = f.callsOf('tab.create');
    expect(create.length).toBe(1);
    expect(create[0].params).toEqual({ workspace_id: 'w1', label: 'advisor', cwd: '/work/dir', focus: false });
    expect(f.callsOf('pane.split').length).toBe(0);
    expect(r.workspaceId).toBe('w1');
    expect(f.st.tabs[0].tab_id).toBe(r.tabId);
    expect(r.paneId).toBe(f.st.panes[0].pane_id);
  });

  test('2nd splits right, 3rd down, alternating, each targeting the last pane', async () => {
    const f = fake();
    const a = await ensureWorkerPane(baseArgs(f));
    const b = await ensureWorkerPane(baseArgs(f));
    const c = await ensureWorkerPane(baseArgs(f));
    const d = await ensureWorkerPane(baseArgs(f));
    const splits = f.callsOf('pane.split').map((s) => s.params);
    expect(splits.map((s) => s.direction)).toEqual(['right', 'down', 'right']);
    expect(splits.map((s) => s.target_pane_id)).toEqual([a.paneId, b.paneId, c.paneId]);
    for (const s of splits) expect(s).toMatchObject({ ratio: 0.5, cwd: '/work/dir', focus: false });
    expect(new Set([a.tabId, b.tabId, c.tabId, d.tabId]).size).toBe(1);
    expect(f.callsOf('tab.create').length).toBe(1);
  });

  test('7th worker goes to tab "advisor-2", 13th to "advisor-3"', async () => {
    const f = fake();
    const out = [];
    for (let i = 0; i < 7; i++) out.push(await ensureWorkerPane(baseArgs(f)));
    expect(f.st.tabs.map((t) => t.label)).toEqual(['advisor', 'advisor-2']);
    expect(out[6].tabId).not.toBe(out[0].tabId);
    expect(out[5].tabId).toBe(out[0].tabId);
    for (let i = 7; i < 13; i++) out.push(await ensureWorkerPane(baseArgs(f)));
    expect(f.st.tabs.map((t) => t.label)).toEqual(['advisor', 'advisor-2', 'advisor-3']);
  });

  test('a foreign pane inside tab "advisor" counts toward the cap and is never touched', async () => {
    const f = fake({
      tabs: [{ tab_id: 'w1:t1', label: 'advisor' }],
      panes: Array.from({ length: 5 }, (_, i) => ({ pane_id: `w1:p${i + 1}`, tab_id: 'w1:t1' })),
    });
    const a = await ensureWorkerPane(baseArgs(f));
    expect(a.tabId).toBe('w1:t1');
    expect(f.callsOf('pane.split')[0].params.target_pane_id).toBe('w1:p5');
    expect(f.callsOf('pane.split')[0].params.direction).toBe('right');
    const b = await ensureWorkerPane(baseArgs(f));
    expect(b.tabId).not.toBe('w1:t1');
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('tab lookup is by exact label: tabs "1" and "advisor-old" are ignored', async () => {
    const f = fake({ tabs: [{ tab_id: 'w1:t1', label: '1' }, { tab_id: 'w1:t2', label: 'advisor-old' }], panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    await ensureWorkerPane(baseArgs(f));
    expect(f.callsOf('tab.create').length).toBe(1);
    expect(f.callsOf('pane.split').length).toBe(0);
  });

  test('a user-closed advisor tab is recreated by label lookup', async () => {
    const f = fake();
    const a = await ensureWorkerPane(baseArgs(f));
    f.st.tabs = [];
    f.st.panes = [];
    const b = await ensureWorkerPane(baseArgs(f));
    expect(b.tabId).not.toBe(a.tabId);
    expect(f.callsOf('tab.create').length).toBe(2);
  });

  test('missing HERDR_WORKSPACE_ID falls back to pane.get(HERDR_PANE_ID).workspace_id', async () => {
    const f = fake({ workspaceId: 'w7', panes: [{ pane_id: 'w7:p1', tab_id: 'w7:t1' }] });
    const r = await ensureWorkerPane(baseArgs(f, { env: { HERDR_PANE_ID: 'w7:p1' } }));
    expect(f.callsOf('pane.get')[0].params).toEqual({ pane_id: 'w7:p1' });
    expect(r.workspaceId).toBe('w7');
    expect(f.callsOf('tab.create')[0].params.workspace_id).toBe('w7');
  });

  test('neither workspace nor pane env -> HERDR_NO_WORKSPACE, nothing created', async () => {
    const f = fake();
    const err = await ensureWorkerPane(baseArgs(f, { env: {} })).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('HERDR_NO_WORKSPACE');
    expect(f.callsOf('tab.create').length).toBe(0);
  });

  test('pane.get fallback failing -> HERDR_NO_WORKSPACE', async () => {
    const f = fake();
    const err = await ensureWorkerPane(baseArgs(f, { env: { HERDR_PANE_ID: 'w9:p9' } })).catch((e) => e);
    expect(err.code).toBe('HERDR_NO_WORKSPACE');
    expect(f.callsOf('tab.create').length).toBe(0);
  });

  test('two concurrent calls create exactly one "advisor" tab (mkdir lock)', async () => {
    const f = fake({ delay: true });
    const [a, b] = await Promise.all([ensureWorkerPane(baseArgs(f)), ensureWorkerPane(baseArgs(f))]);
    expect(f.st.tabs.filter((t) => t.label === 'advisor').length).toBe(1);
    expect(f.callsOf('tab.create').length).toBe(1);
    expect(f.st.panes.length).toBe(2);
    expect(a.tabId).toBe(b.tabId);
    expect(a.paneId).not.toBe(b.paneId);
  });

  test('lock directory is released after the call, also when creation throws', async () => {
    const f = fake();
    const lockDir = path.join(tmp, 'locks', 'x.lock');
    await ensureWorkerPane(baseArgs(f, { lockDir }));
    expect(fs.existsSync(lockDir)).toBe(false);
    f.st.hooks['tab.create'] = () => { throw new FakeHerdrError('internal_error'); };
    f.st.tabs = [];
    await expect(ensureWorkerPane(baseArgs(f, { lockDir }))).rejects.toThrow();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('a lock older than the worst-case critical section is stale and reclaimed', async () => {
    const f = fake();
    const lockDir = path.join(tmp, 'locks', 'stale.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockDir, old, old);
    const r = await ensureWorkerPane(baseArgs(f, { lockDir }));
    expect(r.paneId).toBeTruthy();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('a 60 s old lock is not stale: a slow holder (6 requests at a 10 s timeout) keeps it', async () => {
    const f = fake();
    const lockDir = path.join(tmp, 'locks', 'slow.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const aged = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, aged, aged);
    const p = ensureWorkerPane(baseArgs(f, { lockDir }));
    await new Promise((r) => setTimeout(r, 150));
    expect(f.st.calls.length).toBe(0);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockDir, old, old);
    expect((await p).paneId).toBeTruthy();
  });

  test('W1: a live holder refreshes the lock after each herdr call, so a slow holder is never reclaimed', async () => {
    const f = fake({ delay: true });
    const lockDir = path.join(tmp, 'locks', 'refresh.lock');
    const ageMs = () => Date.now() - fs.statSync(lockDir).mtimeMs;
    let contender;
    let ageAfterSlowCall;
    let tabListsWhileSlow;
    // tab.create "takes" longer than LOCK_STALE_MS: the lock dir looks 10 minutes old when it returns.
    f.st.hooks['tab.create'] = () => { const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lockDir, old, old); return undefined; };
    f.st.hooks['pane.list'] = () => {
      if (contender) return undefined;
      ageAfterSlowCall = ageMs();
      contender = ensureWorkerPane(baseArgs(f, { lockDir }));
      return undefined;
    };
    f.st.hooks['pane.report_metadata'] = async (params) => {
      Object.assign(f.find(params.pane_id).tokens, params.tokens);
      if (tabListsWhileSlow !== undefined) return { type: 'ok' };
      tabListsWhileSlow = -1;
      await new Promise((r) => setTimeout(r, 150));
      tabListsWhileSlow = f.callsOf('tab.list').length;
      return { type: 'ok' };
    };
    const first = await ensureWorkerPane(baseArgs(f, { lockDir }));
    await contender;
    expect(first.tagged).toBe(true);
    expect(ageAfterSlowCall).toBeLessThan(5000);
    expect(tabListsWhileSlow).toBe(1);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('a holder whose lock was taken over as stale never removes the new holder\'s lock', async () => {
    const f = fake({ delay: true });
    const lockDir = path.join(tmp, 'locks', 'owner.lock');
    const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
    const a = gate();
    const b = gate();
    let n = 0;
    f.st.hooks['tab.list'] = (_params, st) => {
      const i = n++;
      if (i > 1) return undefined;
      return (i === 0 ? a : b).p.then(() => ({ type: 'tab_list', tabs: structuredClone(st.tabs) }));
    };
    const waitFor = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true); };
    const pa = ensureWorkerPane(baseArgs(f, { lockDir }));
    await waitFor(() => f.callsOf('tab.list').length === 1);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockDir, old, old);
    const pb = ensureWorkerPane(baseArgs(f, { lockDir }));
    await waitFor(() => f.callsOf('tab.list').length === 2);
    a.open();
    await pa;
    expect(fs.existsSync(lockDir)).toBe(true);
    const pc = ensureWorkerPane(baseArgs(f, { lockDir }));
    await new Promise((r) => setTimeout(r, 100));
    expect(f.callsOf('tab.list').length).toBe(2);
    b.open();
    await Promise.all([pb, pc]);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('an existing advisor tab with no panes is never recreated under the same label', async () => {
    const f = fake({ tabs: [{ tab_id: 'w1:t1', label: 'advisor' }] });
    const r = await ensureWorkerPane(baseArgs(f));
    expect(f.callsOf('tab.create').map((c) => c.params.label)).toEqual(['advisor-2']);
    expect(f.st.tabs.filter((t) => t.label === 'advisor').length).toBe(1);
    expect(r.tabId).not.toBe('w1:t1');
  });
});

describe('pidAlive', () => {
  test('EPERM (a process owned by another user) is NOT alive; ESRCH is not alive; own pid is alive', () => {
    fake();
    const real = process.kill;
    try {
      process.kill = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
      expect(pidAlive(4242)).toBe(false);
      process.kill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
      expect(pidAlive(4242)).toBe(false);
    } finally {
      process.kill = real;
    }
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive('1')).toBe(false);
  });
});

// ── allocateEnsemblePanes ─────────────────────────────────────────────────────

describe('allocateEnsemblePanes', () => {
  test('3 sids -> one tab ensemble-3-<date> with 3 panes, alternating splits', async () => {
    const f = fake();
    const sids = ['s1', 's2', 's3'];
    const out = await allocateEnsemblePanes({
      client: f.client, env: { HERDR_WORKSPACE_ID: 'w1' }, sids, lockDir: path.join(tmp, 'l.lock'), cwd: '/work', dateStamp: '20261109',
    });
    expect(f.callsOf('tab.create').length).toBe(1);
    expect(f.callsOf('tab.create')[0].params).toEqual({ workspace_id: 'w1', label: 'ensemble-3-20261109', cwd: '/work', focus: false });
    expect(f.st.tabs.length).toBe(1);
    expect(f.st.panes.length).toBe(3);
    expect(f.callsOf('pane.split').map((s) => s.params.direction)).toEqual(['right', 'down']);
    expect(out.map((o) => o.sid)).toEqual(sids);
    expect(new Set(out.map((o) => o.paneId)).size).toBe(3);
    for (const o of out) expect(o).toMatchObject({ tabId: f.st.tabs[0].tab_id, workspaceId: 'w1' });
    expect(f.callsOf('tab.create').filter((c) => c.params.label === 'advisor').length).toBe(0);
  });

  test('missing workspace -> HERDR_NO_WORKSPACE', async () => {
    const f = fake();
    const err = await allocateEnsemblePanes({ client: f.client, env: {}, sids: ['a', 'b'], lockDir: path.join(tmp, 'l.lock'), cwd: '/w', dateStamp: '20261109' }).catch((e) => e);
    expect(err.code).toBe('HERDR_NO_WORKSPACE');
    expect(f.callsOf('tab.create').length).toBe(0);
  });
});

// ── tagging inside the placement lock (D7) ────────────────────────────────────

describe('placement tags every pane inside the lock', () => {
  const flaky = (f, failIds) => {
    f.st.hooks['pane.report_metadata'] = (params) => {
      if (failIds.includes(params.pane_id)) throw new FakeHerdrError('socket_error', 'report failed');
      return undefined;
    };
  };
  const ens = (f, sids, extra = {}) => allocateEnsemblePanes({
    client: f.client, env: { HERDR_WORKSPACE_ID: 'w1' }, sids, lockDir: path.join(tmp, 'l.lock'), cwd: '/w', dateStamp: '20261109', ...extra,
  });

  test('ensureWorkerPane tags the new tab root and every split pane, inside the lock', async () => {
    const f = fake();
    const lockDir = path.join(tmp, 'locks', 'herdr-placement.lock');
    const heldAtTag = [];
    f.st.hooks['pane.report_metadata'] = () => { heldAtTag.push(fs.existsSync(lockDir)); return undefined; };
    const a = await ensureWorkerPane(baseArgs(f, { sid: 'sid-a' }));
    const b = await ensureWorkerPane(baseArgs(f, { sid: 'sid-b' }));
    expect(a.tagged).toBe(true);
    expect(b.tagged).toBe(true);
    expect(f.find(a.paneId).tokens.advisor_sid).toBe('sid-a');
    expect(f.find(b.paneId).tokens.advisor_sid).toBe('sid-b');
    expect(heldAtTag).toEqual([true, true]);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('ensureWorkerPane: a tag failure still returns the pane with tagged:false and tagError', async () => {
    const f = fake();
    flaky(f, ['w1:p10']);
    const r = await ensureWorkerPane(baseArgs(f));
    expect(r.paneId).toBe('w1:p10');
    expect(r.tagged).toBe(false);
    expect(r.tagError).toBeInstanceOf(Error);
    expect(r.tagError.message).toBe('tag-verify-failed');
    expect(r.tagError.cause.code).toBe('socket_error');
  });

  test('allocateEnsemblePanes tags each pane with its own sid right after its create/split, inside the lock', async () => {
    const f = fake();
    const lockDir = path.join(tmp, 'l.lock');
    const heldAtTag = [];
    f.st.hooks['pane.report_metadata'] = () => { heldAtTag.push(fs.existsSync(lockDir)); return undefined; };
    const out = await ens(f, ['s1', 's2', 's3']);
    expect(out.map((o) => o.tagged)).toEqual([true, true, true]);
    for (const o of out) expect(f.find(o.paneId).tokens.advisor_sid).toBe(o.sid);
    expect(heldAtTag).toEqual([true, true, true]);
    const seq = f.methods().filter((m) => ['tab.create', 'pane.split', 'pane.report_metadata'].includes(m));
    expect(seq).toEqual(['tab.create', 'pane.report_metadata', 'pane.split', 'pane.report_metadata', 'pane.split', 'pane.report_metadata']);
  });

  test('allocateEnsemblePanes: a tag failure on session 2 of 3 does not stop sessions 1 and 3', async () => {
    const f = fake();
    flaky(f, ['w1:p11']);
    const out = await ens(f, ['s1', 's2', 's3']);
    expect(out.map((o) => o.tagged)).toEqual([true, false, true]);
    expect(out[1].tagError.message).toBe('tag-verify-failed');
    expect(out[0].tagError).toBeUndefined();
    expect(f.find(out[0].paneId).tokens.advisor_sid).toBe('s1');
    expect(f.find(out[1].paneId).tokens).toEqual({});
    expect(f.find(out[2].paneId).tokens.advisor_sid).toBe('s3');
    expect(out.map((o) => o.sid)).toEqual(['s1', 's2', 's3']);
  });

  test('allocateEnsemblePanes: a split failing partway tags the panes already created, then rethrows', async () => {
    const f = fake();
    let splits = 0;
    f.st.hooks['pane.split'] = () => { if (++splits === 2) throw new FakeHerdrError('socket_error', 'split failed'); return undefined; };
    const err = await ens(f, ['s1', 's2', 's3', 's4']).catch((e) => e);
    expect(err.code).toBe('socket_error');
    expect(f.st.panes.length).toBe(2);
    expect(f.st.panes.map((p) => p.tokens.advisor_sid)).toEqual(['s1', 's2']);
    expect(fs.existsSync(path.join(tmp, 'l.lock'))).toBe(false);
  });

  test('allocateEnsemblePanes: a tag failure while unwinding a partial allocation does not mask the split error', async () => {
    const f = fake();
    flaky(f, ['w1:p10']);
    f.st.hooks['pane.split'] = () => { throw new FakeHerdrError('socket_error', 'split failed'); };
    const err = await ens(f, ['s1', 's2']).catch((e) => e);
    expect(err.message).toBe('split failed');
    expect(f.st.panes.length).toBe(1);
  });
});

// ── closePaneChecked ──────────────────────────────────────────────────────────

describe('closePaneChecked', () => {
  const mk = (tokens, extra = {}) => fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens, ...extra }] });
  const runDir = () => path.join(tmp, 'runs', SID);

  test('token matches -> pane.close, reason closed', async () => {
    const f = mk({ advisor_sid: SID });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: false });
    expect(r).toEqual({ closed: true, reason: 'closed' });
    expect(f.callsOf('pane.close')).toEqual([{ method: 'pane.close', params: { pane_id: 'w1:p2' } }]);
  });

  test('reused pane id carrying another sid -> token-mismatch, no pane.close', async () => {
    const f = mk({ advisor_sid: 'someone-else' });
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r).toEqual({ closed: false, reason: 'token-mismatch' });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('token absent + runner.json pane matches + runnerAlive:true -> still untokened-refused', async () => {
    const f = mk({});
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r).toEqual({ closed: false, reason: 'untokened-refused' });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('token absent, runnerAlive:true, no runDir at all -> untokened-refused', async () => {
    const f = mk({});
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runnerAlive: true });
    expect(r).toEqual({ closed: false, reason: 'untokened-refused' });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('token absent + runnerAlive:false -> untokened-refused', async () => {
    const f = mk({});
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: false });
    expect(r).toEqual({ closed: false, reason: 'untokened-refused' });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('token absent + runnerAlive merely truthy (not === true) -> untokened-refused', async () => {
    const f = mk({});
    writeRunner(runDir(), { pane_id: 'w1:p2' });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: 1 });
    expect(r.reason).toBe('untokened-refused');
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('token absent + runner.json names a different pane -> untokened-refused', async () => {
    const f = mk({});
    writeRunner(runDir(), { pane_id: 'w1:p7' });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r.reason).toBe('untokened-refused');
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('token absent + no runner.json or malformed runner.json -> untokened-refused', async () => {
    const f = mk({});
    let r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r.reason).toBe('untokened-refused');
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), 'runner.json'), '{not json');
    r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r.reason).toBe('untokened-refused');
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('pane_not_found -> gone', async () => {
    const f = fake();
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r).toEqual({ closed: false, reason: 'gone' });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('socket down -> unavailable, no close', async () => {
    const f = mk({ advisor_sid: SID });
    f.st.down = true;
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r).toEqual({ closed: false, reason: 'unavailable' });
  });

  test('pane vanishes between get and close -> gone', async () => {
    const f = mk({ advisor_sid: SID });
    f.st.hooks['pane.close'] = () => { throw new FakeHerdrError('pane_not_found'); };
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r.reason).toBe('gone');
  });

  test('100-char sid: token compare is on the first 80 chars', async () => {
    const long = 'b'.repeat(100);
    const f = mk({ advisor_sid: 'b'.repeat(80) });
    const r = await closePaneChecked({ client: f.client, sid: long, paneId: 'w1:p2', runDir: runDir(), runnerAlive: false });
    expect(r.reason).toBe('closed');
  });

  test('empty sid never matches a token', async () => {
    const f = mk({ advisor_sid: '' });
    const r = await closePaneChecked({ client: f.client, sid: '', paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r.closed).toBe(false);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('a method outside the allow-list is refused before it reaches the client', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
    const r = await closePaneChecked({ client: f.client, sid: SID, paneId: 'w1:p2', runDir: runDir(), runnerAlive: true });
    expect(r.closed).toBe(true);
    expect(f.methods().every((m) => ALLOWED.includes(m))).toBe(true);
  });
});

// ── closeWorkerBySid ──────────────────────────────────────────────────────────

describe('closeWorkerBySid', () => {
  const runDir = () => path.join(tmp, 'runs', SID);

  test('closes only token-matching panes; a foreign pane in the same tab stays', async () => {
    const f = fake({
      panes: [
        { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: 'other-sid' } },
        { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: SID } },
        { pane_id: 'w1:p3', tab_id: 'w1:t1', tokens: {} },
      ],
    });
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r.closed).toEqual(['w1:p2']);
    expect(f.callsOf('pane.close').map((c) => c.params.pane_id)).toEqual(['w1:p2']);
    expect(f.st.panes.map((p) => p.pane_id)).toEqual(['w1:p1', 'w1:p3']);
  });

  test('runner.json pane reused by a different sid is refused, not closed', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'other-sid' } }] });
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r.closed).toEqual([]);
    expect(r.refused).toEqual([{ paneId: 'w1:p2', reason: 'token-mismatch' }]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('untokened runner.json pane + dead runner pid -> refused untokened-refused', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: {} }] });
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: 2147483646 });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r.refused).toEqual([{ paneId: 'w1:p2', reason: 'untokened-refused' }]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('untokened runner.json pane + live runner pid -> refused, never closed', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: {} }] });
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r.closed).toEqual([]);
    expect(r.refused).toEqual([{ paneId: 'w1:p2', reason: 'untokened-refused' }]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('stale runner.json with a foreign-owned pid (pid 1) and a reused untokened pane id is not closed', async () => {
    const f = fake({ panes: [{ pane_id: 'p_3', tab_id: 'w1:t1', tokens: {} }] });
    writeRunner(runDir(), { pid: 1, backend: 'herdr', pane_id: 'p_3' });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r).toEqual({ closed: [], refused: [{ paneId: 'p_3', reason: 'untokened-refused' }] });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('no runner.json: token scan alone finds the pane; a pane listed twice is closed once', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r).toEqual({ closed: ['w1:p2'], refused: [] });
    expect(f.callsOf('pane.close').length).toBe(1);
  });

  test('already-gone runner pane is neither closed nor refused', async () => {
    const f = fake();
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r).toEqual({ closed: [], refused: [] });
  });

  test('socket down -> nothing closed, refusal reported as unavailable', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
    f.st.down = true;
    writeRunner(runDir(), { pane_id: 'w1:p2', pid: process.pid });
    const r = await closeWorkerBySid({ client: f.client, sid: SID, runDir: runDir() });
    expect(r.closed).toEqual([]);
    expect(r.refused.every((x) => x.reason === 'unavailable')).toBe(true);
    expect(f.callsOf('pane.close').length).toBe(0);
  });
});

// ── closeSelf ─────────────────────────────────────────────────────────────────

describe('closeSelf', () => {
  const env = (extra = {}) => ({ HERDR_PANE_ID: 'w1:p2', ADVISOR_SID: SID, ADVISOR_RUNS_ROOT: path.join(tmp, 'runs'), ...extra });

  test('closes only HERDR_PANE_ID when the token matches ADVISOR_SID', async () => {
    const f = fake({
      panes: [
        { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: SID } },
        { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: SID } },
      ],
    });
    const r = await closeSelf({ client: f.client, env: env() });
    expect(r.closed).toBe(true);
    expect(f.callsOf('pane.close').map((c) => c.params.pane_id)).toEqual(['w1:p2']);
    expect(f.find('w1:p1')).toBeTruthy();
  });

  test('refuses when the ADVISOR_SID token differs', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'other-sid' } }] });
    const r = await closeSelf({ client: f.client, env: env() });
    expect(r.closed).toBe(false);
    expect(r.reason).toBe('token-mismatch');
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('no-op without HERDR_PANE_ID or ADVISOR_SID, and makes no socket call', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: SID } }] });
    expect((await closeSelf({ client: f.client, env: env({ HERDR_PANE_ID: undefined }) })).closed).toBe(false);
    expect((await closeSelf({ client: f.client, env: env({ ADVISOR_SID: '' }) })).closed).toBe(false);
    expect(f.st.calls.length).toBe(0);
  });

  test('untokened pane is refused whatever runner.json says, even a matching pane and a live pid', async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: {} }] });
    const dir = path.join(tmp, 'runs', SID);
    expect((await closeSelf({ client: f.client, env: env() })).reason).toBe('untokened-refused');
    writeRunner(dir, { pane_id: 'w1:p2', pid: 2147483646 });
    expect((await closeSelf({ client: f.client, env: env() })).reason).toBe('untokened-refused');
    writeRunner(dir, { pane_id: 'w1:p9', pid: process.pid });
    expect((await closeSelf({ client: f.client, env: env() })).reason).toBe('untokened-refused');
    writeRunner(dir, { pane_id: 'w1:p2', pid: process.pid });
    expect(await closeSelf({ client: f.client, env: env() })).toEqual({ closed: false, reason: 'untokened-refused' });
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('pane already gone -> not closed, reason gone', async () => {
    const f = fake();
    const r = await closeSelf({ client: f.client, env: env() });
    expect(r).toEqual({ closed: false, reason: 'gone' });
  });
});

// ── reapOrphanHerdrPanes ──────────────────────────────────────────────────────

describe('reapOrphanHerdrPanes', () => {
  const now = Date.now();
  const sidAged = (h, tag) => `${Math.floor(now / 1000) - Math.round(h * 3600)}-${tag}`;
  const mkRun = (sid, mtimeAgoH = 30) => {
    const dir = path.join(tmp, 'runs', sid);
    fs.mkdirSync(dir, { recursive: true });
    const sj = path.join(dir, 'session.json');
    fs.writeFileSync(sj, '{}');
    const t = new Date(now - mtimeAgoH * HOUR);
    fs.utimesSync(sj, t, t);
    return dir;
  };
  const pane = (id, sid) => ({ pane_id: id, tab_id: 'w1:t1', tokens: sid ? { advisor_sid: sid } : {} });
  const reap = (f, pgrep = () => false) => reapOrphanHerdrPanes({ client: f.client, runsDir: path.join(tmp, 'runs'), now, pgrep });

  test('closes a stale tokened pane (sid > 2 h, session.json > 24 h, no process)', async () => {
    const sid = sidAged(5, 'stale1');
    mkRun(sid, 30);
    const f = fake({ panes: [pane('w1:p2', sid)] });
    expect(await reap(f)).toEqual(['w1:p2']);
    expect(f.callsOf('pane.close').length).toBe(1);
  });

  test('skips when session.json is fresher than 24 h', async () => {
    const sid = sidAged(5, 'fresh1');
    mkRun(sid, 23);
    const f = fake({ panes: [pane('w1:p2', sid)] });
    expect(await reap(f)).toEqual([]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('skips when the sid timestamp is younger than 2 h', async () => {
    const sid = sidAged(1, 'young1');
    mkRun(sid, 30);
    const f = fake({ panes: [pane('w1:p2', sid)] });
    expect(await reap(f)).toEqual([]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('skips when pgrep finds a live process for the sid (sync or async stub)', async () => {
    const sid = sidAged(5, 'live1');
    mkRun(sid, 30);
    const f = fake({ panes: [pane('w1:p2', sid)] });
    const seen = [];
    expect(await reap(f, (s) => { seen.push(s); return true; })).toEqual([]);
    expect(await reap(f, async () => true)).toEqual([]);
    expect(seen).toEqual([sid]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('skips untokened panes, even when a run dir could match', async () => {
    const sid = sidAged(5, 'untok1');
    mkRun(sid, 30);
    writeRunner(path.join(tmp, 'runs', sid), { pane_id: 'w1:p2', pid: process.pid });
    const f = fake({ panes: [pane('w1:p2', null)] });
    expect(await reap(f)).toEqual([]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('skips a tokened pane whose run dir is missing', async () => {
    const f = fake({ panes: [pane('w1:p2', sidAged(5, 'nodir1'))] });
    expect(await reap(f)).toEqual([]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('skips a tokened pane whose session.json is missing or whose sid has no timestamp prefix', async () => {
    const sidA = sidAged(5, 'nosj1');
    fs.mkdirSync(path.join(tmp, 'runs', sidA), { recursive: true });
    const sidB = 'not-a-timestamp';
    mkRun(sidB, 30);
    const f = fake({ panes: [pane('w1:p2', sidA), pane('w1:p3', sidB)] });
    expect(await reap(f)).toEqual([]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('a token that tries to escape runsDir is skipped', async () => {
    const f = fake({ panes: [pane('w1:p2', '../' + sidAged(5, 'esc1'))] });
    mkRun(sidAged(5, 'esc1'), 30);
    expect(await reap(f)).toEqual([]);
    expect(f.callsOf('pane.close').length).toBe(0);
  });

  test('reaps only the stale pane among stale, fresh and foreign panes; returns closed ids', async () => {
    const stale = sidAged(5, 'mix-stale');
    const fresh = sidAged(5, 'mix-fresh');
    mkRun(stale, 30);
    mkRun(fresh, 2);
    const f = fake({ panes: [pane('w1:p1', null), pane('w1:p2', stale), pane('w1:p3', fresh)] });
    expect(await reap(f)).toEqual(['w1:p2']);
    expect(f.st.panes.map((p) => p.pane_id)).toEqual(['w1:p1', 'w1:p3']);
  });

  test('socket down -> returns [] without throwing', async () => {
    const f = fake();
    f.st.down = true;
    expect(await reap(f)).toEqual([]);
  });

  test('default pgrep never throws and the call is still safe', async () => {
    const sid = sidAged(5, 'defpg1');
    mkRun(sid, 30);
    const f = fake({ panes: [pane('w1:p2', sid)] });
    const out = await reapOrphanHerdrPanes({ client: f.client, runsDir: path.join(tmp, 'runs'), now });
    expect(Array.isArray(out)).toBe(true);
  });
});

// ── probeRunnerPane ───────────────────────────────────────────────────────────

describe('probeRunnerPane', () => {
  const runDir = () => path.join(tmp, 'runs', SID);

  test("no runner.json -> 'no-record'; runner.json without pane_id -> 'no-record'; malformed -> 'no-record'", async () => {
    const f = fake();
    expect(await probeRunnerPane({ client: f.client, runDir: runDir() })).toBe('no-record');
    writeRunner(runDir(), { pid: 1 });
    expect(await probeRunnerPane({ client: f.client, runDir: runDir() })).toBe('no-record');
    fs.writeFileSync(path.join(runDir(), 'runner.json'), 'nope');
    expect(await probeRunnerPane({ client: f.client, runDir: runDir() })).toBe('no-record');
    expect(f.st.calls.length).toBe(0);
  });

  test("pane present -> 'alive'", async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1' }] });
    writeRunner(runDir(), { pane_id: 'w1:p2' });
    expect(await probeRunnerPane({ client: f.client, runDir: runDir() })).toBe('alive');
  });

  test("pane_not_found -> 'gone'", async () => {
    const f = fake();
    writeRunner(runDir(), { pane_id: 'w1:p2' });
    expect(await probeRunnerPane({ client: f.client, runDir: runDir() })).toBe('gone');
  });

  test("socket down -> 'unknown', never 'gone'", async () => {
    const f = fake({ panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1' }] });
    f.st.down = true;
    writeRunner(runDir(), { pane_id: 'w1:p2' });
    const s = await probeRunnerPane({ client: f.client, runDir: runDir() });
    expect(s).toBe('unknown');
    expect(s).not.toBe('gone');
  });
});
