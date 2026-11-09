import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Live herdr 0.9.5 backend test. Skipped unless ADVISOR_HERDR_ITEST=1; runs ONLY against its own
// `herdr --session advisor-itest` server and refuses to start any mutation on the default socket.
const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dir, '..');
const RUNNER = path.join(ROOT, 'lib', 'herdr-runner.js');
const OBSERVE = path.join(ROOT, 'bin', 'advisor-observe');
// Per-process suffix: concurrent runs must not share (or stop) each other's isolated server.
const SESS = `advisor-itest-${process.pid}`;
const DEFAULT_SOCK = path.join(process.env.HOME || os.homedir(), '.config', 'herdr', 'herdr.sock');
const d = process.env.ADVISOR_HERDR_ITEST === '1' ? describe : describe.skip;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  return fn();
};

d('herdr backend live (isolated session advisor-itest)', () => {
  const savedEnv = {};
  let tmp; let cleanEnv; let sock; let server; let workspaceId; let rootPane; let client;
  let R; let panes; let createClient;
  let n = 0;

  const herdr = (...args) => spawnSync('herdr', ['--session', SESS, ...args], { encoding: 'utf8', env: cleanEnv });
  const herdrJson = (...args) => JSON.parse(herdr(...args).stdout);
  const sessionInfo = () => {
    const r = spawnSync('herdr', ['session', 'list', '--json'], { encoding: 'utf8', env: cleanEnv });
    return (JSON.parse(r.stdout).sessions || []).find((s) => s.name === SESS) || null;
  };
  const newPane = () => herdrJson('pane', 'split', rootPane, '--direction', 'right', '--cwd', tmp, '--no-focus').result.pane.pane_id;

  function mkRun(launchBody, prompt = 'unused') {
    const sid = `itest-${Date.now()}-${++n}`;
    const runDir = path.join(tmp, 'runs', sid);
    fs.mkdirSync(path.join(runDir, 'channel'), { recursive: true });
    const outbox = path.join(runDir, 'channel', 'outbox.jsonl');
    fs.writeFileSync(outbox, '');
    const launchScript = path.join(runDir, 'launch.sh');
    fs.writeFileSync(launchScript, `#!/bin/bash\n${launchBody}\n`);
    const promptFile = path.join(runDir, 'prompt.txt');
    fs.writeFileSync(promptFile, prompt);
    return { sid, runDir, outbox, launchScript, promptFile };
  }
  // The Stop-hook sentinel is only accepted when claude's cwd is under the run dir, so claude starts there.
  const claudeRun = (nonce) => mkRun('cd "$(dirname "$0")" || exit 1\nexec claude --model haiku', `Reply with exactly: ${nonce}`);
  const outboxLines = (run) => fs.readFileSync(run.outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawnEnv = (extra = {}) => ({ ...cleanEnv, HERDR_SOCKET_PATH: sock, ...extra });
  const readRecord = (run) => { try { return JSON.parse(fs.readFileSync(path.join(run.runDir, 'runner.json'), 'utf8')); } catch (_) { return null; } };

  async function runSpawn(run, paneId, extra = {}) {
    // Placement tags the pane in real runs (D7); the runner only verifies, so tag here first.
    await panes.tagPane(client, paneId, run.sid);
    const chunks = [];
    const orig = process.stderr.write;
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    let outcome;
    try {
      outcome = { value: await R.spawnHeadlessHerdr({
        sid: run.sid, agent: 'coder', launchScript: run.launchScript, promptFile: run.promptFile,
        timeoutMs: 240000, paneId, tabId: 'w:t', workspaceId, env: spawnEnv({ ADVISOR_CAPTURE_TIMEOUT_MS: '45000' }), ...extra,
      }) };
    } catch (err) { outcome = { err }; } finally { process.stderr.write = orig; }
    return { ...outcome, log: chunks.join('') };
  }

  function runCli(args, { env = {}, input = '' } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNNER, ...args], { env: { ...cleanEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (x) => { stdout += x; });
      child.stderr.on('data', (x) => { stderr += x; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  const lastJson = (res) => JSON.parse(res.stdout.trim().split('\n').pop());

  beforeAll(async () => {
    R = require('../lib/herdr-runner.js');
    panes = require('../lib/herdr-panes.js');
    ({ createClient } = require('../lib/herdr-client.js'));
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HERDR_') || k === 'ADVISOR_HERDR') { savedEnv[k] = process.env[k]; delete process.env[k]; }
    }
    // Under the repo so claude inherits the repo's trust and shows no trust dialog in the run dirs.
    tmp = fs.mkdtempSync(path.join(ROOT, '.herdr-itest-'));
    cleanEnv = { ...process.env, ADVISOR_RUNS_ROOT: path.join(tmp, 'runs'), ADVISOR_NO_REAPER: '1' };
    for (const k of [...R.HERDR_STRIP_ENV]) delete cleanEnv[k];

    const existing = sessionInfo();
    if (existing && existing.running) throw new Error(`session ${SESS} is already running; refusing to touch it`);
    server = spawn('herdr', ['--session', SESS, 'server'], { env: cleanEnv, stdio: 'ignore' });
    const info = await waitFor(() => { const s = sessionInfo(); return s && s.running && s.socket_path ? s : null; }, 30000);
    sock = info && info.socket_path;
    const status = herdr('status', 'server', '--json').stdout;
    // Gate: nothing below mutates anything until the socket is proven to be the isolated one.
    if (!sock || sock === DEFAULT_SOCK || !status.includes(SESS)) throw new Error(`GATE FAIL: socket=${sock}`);
    console.log(`GATE OK: isolated socket ${sock} != ${DEFAULT_SOCK}`);
    const ws = herdrJson('workspace', 'create', '--cwd', tmp, '--label', 'itest-ws', '--no-focus').result;
    workspaceId = ws.workspace.workspace_id;
    rootPane = ws.root_pane.pane_id;
    client = createClient({ socketPath: sock });
  }, 60000);

  afterAll(async () => {
    try { if (server) server.kill('SIGTERM'); await waitFor(() => { const s = sessionInfo(); return !s || !s.running; }, 8000); } catch (_) { /* fall through */ }
    const s = sessionInfo();
    if (s && s.running) herdr('session', 'stop', SESS); // explicit isolated session name only
    await sleep(1500);
    const left = spawnSync('pgrep', ['-fl', `^herdr --session ${SESS} server`], { encoding: 'utf8' });
    console.log(`TEARDOWN: pgrep '^herdr --session ${SESS}' exit=${left.status} (1 = none) ${left.stdout.trim()}`);
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 30000);

  test('gate: isolated socket is not the default socket', () => {
    expect(sock).toBeTruthy();
    expect(sock).not.toBe(DEFAULT_SOCK);
  });

  test('1+2: --launch-from-meta tags a pane in tab "advisor", writes runner.json, logs the readiness path', async () => {
    const nonce = `NONCE-${Math.random().toString(36).slice(2, 10)}`;
    const run = claudeRun(nonce);
    const meta = { sessions: [{ sid: run.sid, launchScript: run.launchScript, promptFile: run.promptFile }] };
    const res = await runCli(['--launch-from-meta', '--agent', 'coder', '--timeout-ms', '240000'], {
      input: JSON.stringify(meta), env: { HERDR_SOCKET_PATH: sock, HERDR_WORKSPACE_ID: workspaceId, ADVISOR_CAPTURE_TIMEOUT_MS: '45000' },
    });
    expect(res.code).toBe(0);
    const rec = await waitFor(() => readRecord(run), 30000);
    expect(rec).toMatchObject({ backend: 'herdr', mode: 'herdr' });
    const pane = (await client.request('pane.get', { pane_id: rec.pane_id })).pane;
    expect(pane.tokens.advisor_sid).toBe(run.sid);
    const tabs = (await client.request('tab.list', { workspace_id: workspaceId })).tabs;
    expect(tabs.find((t) => t.tab_id === pane.tab_id).label).toBe('advisor');
    const log = path.join(run.runDir, 'herdr-runner.log');
    const text = await waitFor(() => { const t = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''; return /readiness=/.test(t) ? t : null; }, 90000);
    console.log(`READINESS (launch-from-meta child): ${(/\[herdr-runner\] readiness=\S+/.exec(text) || ['none'])[0]}`);
    expect(text).toMatch(/readiness=(agent|footer-fallback)/);
    await waitFor(() => !readRecord(run), 200000);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('Command failed');
  }, 360000);

  test('3: agent.prompt delivers the nonce prompt and claude reply is read back', async () => {
    const nonce = `NONCE-${Math.random().toString(36).slice(2, 10)}`;
    const run = claudeRun(nonce);
    const pane = newPane();
    // The runner closes the pane right after the Stop hook, so the reply is read from the pane while it is open.
    const re = new RegExp(`[⏺●]\\s*${nonce}`);
    let seen = null; let stop = false;
    const poll = (async () => {
      while (!stop && !seen) {
        try { const m = re.exec(((await client.request('pane.read', { pane_id: pane, source: 'visible' })).read || {}).text || ''); if (m) seen = m[0]; } catch (_) { /* pane not ready or gone */ }
        await sleep(50);
      }
    })();
    const res = await runSpawn(run, pane);
    stop = true; await poll;
    console.log(`READINESS (in-process): ${(/\[herdr-runner\] readiness=\S+/.exec(res.log) || ['none'])[0]}`);
    console.log(`REPLY READ BACK from pane: ${JSON.stringify(seen)}; transcript text returned at Stop: ${JSON.stringify(res.value)}`);
    expect(res.err).toBeUndefined();
    expect(seen).toContain(nonce);
    expect(res.log).not.toContain('Command failed');
  }, 300000);

  test('4: a pane exit with a result already in the outbox adds no synthetic line', async () => {
    const run = mkRun('sleep 1\nexit 0');
    fs.writeFileSync(run.outbox, JSON.stringify({ seq: 1, type: 'result', body: 'worker done', from: 'worker' }) + '\n');
    const res = await runSpawn(run, newPane(), { env: spawnEnv({ ADVISOR_CAPTURE_TIMEOUT_MS: '8000' }), timeoutMs: 60000 });
    expect(res.err).toBeUndefined();
    expect(res.value).toBe('worker done');
    expect(outboxLines(run)).toHaveLength(1);
    expect(res.log).toContain('result_in_outbox=true');
  }, 90000);

  let deadPane; let deadRun;
  test('5: a pane exit without a result seals pane-died and --pane-state reports gone', async () => {
    deadRun = mkRun('sleep 1\nexit 7');
    deadPane = newPane();
    const pending = runSpawn(deadRun, deadPane, { env: spawnEnv({ ADVISOR_CAPTURE_TIMEOUT_MS: '8000' }), timeoutMs: 60000 });
    const rec = await waitFor(() => readRecord(deadRun), 20000);
    const res = await pending;
    expect(String(res.err && res.err.message)).toContain('reason=pane-died');
    const lines = outboxLines(deadRun);
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0].body)).toContain('reason=pane-died');
    fs.writeFileSync(path.join(deadRun.runDir, 'runner.json'), JSON.stringify(rec)); // cleanup removed it; restore for the probe
    const st = await runCli(['--pane-state', '--sid', deadRun.sid], { env: { HERDR_SOCKET_PATH: sock } });
    expect(lastJson(st)).toEqual({ state: 'gone', pane_id: deadPane });
  }, 90000);

  test('6: --close closes a token-matching pane and refuses a pane whose token belongs to another sid', async () => {
    const a = mkRun('true'); const b = mkRun('true');
    const paneA = newPane();
    await panes.tagPane(client, paneA, a.sid);
    fs.writeFileSync(path.join(b.runDir, 'runner.json'), JSON.stringify({ pid: 0, backend: 'herdr', pane_id: paneA, socket_path: sock }));
    const refused = lastJson(await runCli(['--close', '--sid', b.sid], { env: { HERDR_SOCKET_PATH: sock } }));
    expect(refused.closed).toEqual([]);
    expect(refused.refused.map((r) => r.paneId)).toContain(paneA);
    expect((await client.request('pane.get', { pane_id: paneA })).pane.pane_id).toBe(paneA);
    const closed = lastJson(await runCli(['--close', '--sid', a.sid], { env: { HERDR_SOCKET_PATH: sock } }));
    expect(closed).toEqual({ closed: [paneA], refused: [] });
    await expect(client.request('pane.get', { pane_id: paneA })).rejects.toMatchObject({ code: 'pane_not_found' });
  }, 60000);

  test('7: advisor-observe on a sid whose pane is gone with no result exits with reason dead', () => {
    const run = mkRun('true');
    fs.writeFileSync(path.join(run.runDir, 'runner.json'), JSON.stringify({ pid: process.pid, backend: 'herdr', mode: 'herdr', pane_id: deadPane, socket_path: sock }));
    const res = spawnSync(process.execPath, [OBSERVE, run.sid, '--max-wait', '60', '--poll', '500'], { encoding: 'utf8', env: spawnEnv(), timeout: 90000 });
    const exit = JSON.parse(res.stdout.trim().split('\n').filter((l) => l.includes('observe_exit')).pop());
    expect(res.status).toBe(3);
    expect(exit).toMatchObject({ type: 'observe_exit', code: 3, reason: 'dead' });
  }, 100000);
});
