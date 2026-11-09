import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeHerdr } from './fixtures/herdr-fake-server.js';

const require = createRequire(import.meta.url);
const SCRIPT = path.join(import.meta.dir, '..', 'lib', 'herdr-runner.js');
const R = () => require('../lib/herdr-runner.js');
const { HerdrError, HerdrUnavailableError, createClient } = require('../lib/herdr-client.js');

const HERDR_KEYS = ['ADVISOR_HERDR', 'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID'];
const STRIP = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'SSE_PORT', 'CHILD_SESSION', 'ENTRYPOINT'];

let tmp;
let savedHome;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-test-'));
  savedHome = process.env.HOME;
  process.env.HOME = path.join(tmp, 'home'); // ensureStopHook writes under HOME
  for (const k of HERDR_KEYS) delete process.env[k];
});
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function mkRun() {
  const runDir = path.join(tmp, 'runs', `sid-${++n}`);
  fs.mkdirSync(path.join(runDir, 'channel'), { recursive: true });
  const outbox = path.join(runDir, 'channel', 'outbox.jsonl');
  fs.writeFileSync(outbox, '');
  fs.writeFileSync(path.join(runDir, 'launch.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'do the thing');
  return { sid: path.basename(runDir), runDir, outbox, launchScript: path.join(runDir, 'launch.sh'), promptFile: path.join(runDir, 'prompt.txt') };
}
const outboxLines = (run) => fs.readFileSync(run.outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const methods = (s) => s.calls.map((c) => c.method);
const closes = (s) => s.calls.filter((c) => c.method === 'pane.close');

function makeStub({ text = '  ? for shortcuts', agent = 'claude', agentStatus = 'idle' } = {}) {
  const s = { calls: [], gone: false, tokens: {}, text, agent, agentStatus, handlers: null, hooks: {}, subClosed: false, sendTexts: 0, snapshots: {} };
  s.request = async (method, params = {}) => {
    s.calls.push({ method, params });
    if (s.hooks[method]) {
      const r = await s.hooks[method](params, s);
      if (r !== undefined) return r;
    }
    if (method === 'ping') return { type: 'pong', version: '0.9.5', protocol: 22 };
    if (s.gone) throw new HerdrError('pane_not_found', `pane ${params.pane_id} not found`);
    switch (method) {
      case 'pane.report_metadata': s.tokens = { ...s.tokens, ...params.tokens }; return { type: 'ok' };
      case 'pane.get': return { type: 'pane_info', pane: { pane_id: params.pane_id, tokens: s.tokens } };
      case 'pane.read': return { type: 'pane_read', read: { text: s.text } };
      case 'pane.close': s.gone = true; return { type: 'ok' };
      case 'pane.send_text': s.sendTexts += 1; return { type: 'ok' };
      case 'agent.get': return { type: 'agent_info', agent: { pane_id: params.target, agent: s.agent, agent_status: s.agentStatus, interactive_ready: true } };
      case 'agent.prompt': s.sendTexts += 1; return { type: 'agent_prompted', agent: { pane_id: params.target, agent: s.agent, agent_status: 'working' } };
      default: return { type: 'ok' };
    }
  };
  s.subscribe = (subs, handlers) => {
    s.calls.push({ method: 'events.subscribe', params: { subscriptions: subs } });
    s.handlers = handlers;
    return { ready: Promise.resolve(), close() { s.subClosed = true; } };
  };
  s.emitExit = (paneId = 'w1:p1') => s.handlers.onEvent({ event: 'pane_exited', paneId, workspaceId: 'w1', raw: {} });
  return s;
}

const sentinelOf = (s) => /CLAUDE_I_SENTINEL='([^']+)'/.exec(s.calls.find((c) => c.method === 'pane.send_text').params.text)[1];
function writeSentinel(s, run, text = 'final answer') {
  const sentinel = sentinelOf(s);
  const transcript = path.join(run.runDir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
  fs.writeFileSync(sentinel + '.json', JSON.stringify({ transcript_path: transcript }));
  fs.writeFileSync(sentinel, '');
}
// Runs fn on the Nth submission (1 = launch command via pane.send_text, 2 = prompt via agent.prompt).
const onSend = (s, nth, fn) => {
  const hook = (params) => {
    if (s.sendTexts + 1 === nth) setTimeout(() => fn(params), 20);
    return undefined;
  };
  s.hooks['pane.send_text'] = hook;
  s.hooks['agent.prompt'] = hook;
};

async function runSpawn(run, s, extra = {}) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  let outcome;
  try {
    const value = await R().spawnHeadlessHerdr({
      sid: run.sid, agent: 'coder', launchScript: run.launchScript, promptFile: run.promptFile,
      timeoutMs: 5000, paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', client: s,
      env: { HERDR_BIN_PATH: '/x/herdr', HERDR_SOCKET_PATH: '/x/sock' }, ...extra,
    });
    outcome = { value };
  } catch (err) {
    outcome = { err };
  } finally {
    process.stderr.write = orig;
  }
  return { ...outcome, log: chunks.join('') };
}

function runCli(args, { env = {}, input = '' } = {}) {
  const base = { ...process.env, HOME: path.join(tmp, 'home'), ADVISOR_NO_REAPER: '1' };
  for (const k of HERDR_KEYS) delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return fn();
};

describe('buildLaunchCommand', () => {
  test('exports HERDR_STRIP_ENV and exec env -u for each name', () => {
    expect(R().HERDR_STRIP_ENV).toEqual(STRIP);
    const cmd = R().buildLaunchCommand({ sid: 's1', sentinel: '/tmp/s.done', launchScript: '/x/launch.sh' });
    for (const name of STRIP) expect(cmd).toContain(`-u ${name}`);
    expect(cmd).toContain('exec env -u');
    expect(cmd.startsWith('ADVISOR_WORKER_BACKEND=herdr ADVISOR_SID=')).toBe(true);
  });

  test('quotes a path with a space and a single quote, and strips env when executed', () => {
    const dir = path.join(tmp, "a b'c");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "it's.sh");
    fs.writeFileSync(script, 'echo "$ADVISOR_WORKER_BACKEND|$ADVISOR_SID|$CLAUDE_I_SENTINEL|${CLAUDECODE-unset}|${SSE_PORT-unset}"\n');
    const cmd = R().buildLaunchCommand({ sid: 'sid x', sentinel: '/tmp/s d.done', launchScript: script });
    const res = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', SSE_PORT: '9' } });
    expect(res.stdout.trim()).toBe('herdr|sid x|/tmp/s d.done|unset|unset');
  });
});

describe('spawnHeadlessHerdr', () => {
  test('spawn order and sentinel path: returns transcript text and closes through the checked close', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.send_text'] = () => {
      s.snapshots.launch = JSON.parse(fs.readFileSync(path.join(run.runDir, 'runner.json'), 'utf8'));
      return undefined;
    };
    s.hooks['agent.prompt'] = () => { setTimeout(() => writeSentinel(s, run), 20); return undefined; };
    const res = await runSpawn(run, s);
    expect(res.err).toBeUndefined();
    expect(res.value).toBe('final answer');
    const seq = methods(s);
    const idx = (m, from = 0) => seq.indexOf(m, from);
    const sub = idx('events.subscribe');
    expect(idx('ping')).toBeLessThan(sub);
    const tag = idx('pane.report_metadata');
    expect(sub).toBeLessThan(tag);
    const launch = idx('pane.send_text');
    expect(tag).toBeLessThan(launch);
    expect(seq[launch + 1]).toBe('pane.send_keys');
    const ready = idx('agent.get', launch);
    expect(ready).toBeGreaterThan(launch + 1);
    const prompt = idx('agent.prompt', ready);
    expect(prompt).toBeGreaterThan(ready);
    expect(seq).not.toContain('pane.read');
    expect(seq.filter((m) => m === 'pane.send_text')).toHaveLength(1);
    expect(s.calls.find((c) => c.method === 'pane.send_text').params.text).toContain('exec env -u');
    expect(s.calls[prompt].params).toEqual({ target: 'w1:p1', text: 'do the thing' });
    const keys = s.calls.filter((c) => c.method === 'pane.send_keys');
    expect(keys).toHaveLength(1);
    expect(keys[0].params).toEqual({ pane_id: 'w1:p1', keys: [R().ENTER_KEY] });
    expect(s.calls[tag].params).toMatchObject({ pane_id: 'w1:p1', source: 'advisor', tokens: { advisor_sid: run.sid } });
    expect(s.snapshots.launch).toMatchObject({ pid: process.pid, mode: 'herdr', backend: 'herdr', pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', socket_path: '/x/sock', herdr_bin: '/x/herdr' });
    expect(closes(s)).toHaveLength(1);
    expect(closes(s)[0].params).toEqual({ pane_id: 'w1:p1' });
    expect(fs.existsSync(path.join(run.runDir, 'runner.json'))).toBe(false);
    expect(fs.existsSync(sentinelOf(s))).toBe(false);
    expect(res.log).toContain(`[herdr-runner] spawn sid=${run.sid} pane=w1:p1 tab=w1:t1 ws=w1`);
    expect(res.log).toContain('[herdr-runner] herdr_bin=/x/herdr protocol=22');
    expect(res.log).toContain('[herdr-runner] readiness=agent');
    expect(s.subClosed).toBe(true);
  });

  test('readiness waits through unknown and working agent states until idle', async () => {
    const run = mkRun();
    const s = makeStub({ agentStatus: 'unknown' });
    let polls = 0;
    s.hooks['agent.get'] = (params) => {
      polls += 1;
      const status = polls < 2 ? 'unknown' : polls < 3 ? 'working' : 'idle';
      return { type: 'agent_info', agent: { pane_id: params.target, agent: 'claude', agent_status: status, interactive_ready: true } };
    };
    s.hooks['agent.prompt'] = () => { setTimeout(() => writeSentinel(s, run), 20); return undefined; };
    const res = await runSpawn(run, s);
    expect(res.value).toBe('final answer');
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(res.log).toContain('[herdr-runner] readiness=agent');
  });

  test('agent never idle: falls back to the footer check, logs the path and still submits via agent.prompt', async () => {
    const run = mkRun();
    const s = makeStub({ agentStatus: 'unknown', agent: null });
    s.hooks['agent.prompt'] = () => { setTimeout(() => writeSentinel(s, run), 20); return undefined; };
    const res = await runSpawn(run, s, { env: { HERDR_BIN_PATH: '/x/herdr', HERDR_SOCKET_PATH: '/x/sock', ADVISOR_CAPTURE_TIMEOUT_MS: '300' } });
    expect(res.value).toBe('final answer');
    expect(res.log).toContain('[herdr-runner] readiness=footer-fallback');
    expect(methods(s)).toContain('pane.read');
    expect(methods(s).indexOf('pane.read')).toBeLessThan(methods(s).indexOf('agent.prompt'));
  });

  test.each(['agent_blocked', 'agent_prompt_stalled'])('agent.prompt %s logs the failure, seals unexpected and never resubmits', async (code) => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['agent.prompt'] = () => { throw new HerdrError(code, 'x'); };
    const res = await runSpawn(run, s);
    expect(res.err).toBeDefined();
    expect(res.log).toContain(`Command failed: herdr agent.prompt ${code}`);
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=unexpected');
    expect(s.calls.filter((c) => c.method === 'agent.prompt')).toHaveLength(1);
    expect(s.calls.filter((c) => c.method === 'pane.send_text')).toHaveLength(1);
  });

  test('pane_exited with a result already in the outbox resolves without a synthetic line', async () => {
    const run = mkRun();
    fs.writeFileSync(run.outbox, JSON.stringify({ seq: 1, type: 'result', body: 'worker done', from: 'worker' }) + '\n');
    const s = makeStub();
    onSend(s, 2, () => s.emitExit());
    const res = await runSpawn(run, s);
    expect(res.err).toBeUndefined();
    expect(res.value).toBe('worker done');
    expect(outboxLines(run)).toHaveLength(1);
    expect(fs.existsSync(path.join(run.runDir, 'runner.json'))).toBe(false);
    expect(res.log).toContain(`[herdr-runner] pane_exited sid=${run.sid} pane=w1:p1 result_in_outbox=true`);
    expect(closes(s)).toHaveLength(0);
  });

  test('pane_exited without a result seals pane-died and rejects', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => s.emitExit());
    const res = await runSpawn(run, s);
    expect(String(res.err && res.err.message)).toBe(`[herdr-runner] worker ended reason=pane-died sid=${run.sid} pane=w1:p1`);
    const lines = outboxLines(run);
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('result');
    expect(JSON.stringify(lines[0].body)).toContain('reason=pane-died');
    expect(res.log).toContain(`[herdr-runner] pane_exited sid=${run.sid} pane=w1:p1 result_in_outbox=false`);
    expect(fs.existsSync(path.join(run.runDir, 'runner.json'))).toBe(false);
    expect(closes(s)).toHaveLength(0);
  });

  test('a pane_exited buffered before the launch steps still seals pane-died and aborts the launch', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.report_metadata'] = () => { s.emitExit(); return undefined; };
    const res = await runSpawn(run, s);
    expect(String(res.err && res.err.message)).toContain('reason=pane-died');
    expect(s.sendTexts).toBe(0);
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=pane-died');
  });

  test('an event for a different pane is ignored', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => { s.emitExit('w1:p9'); setTimeout(() => writeSentinel(s, run), 60); });
    const res = await runSpawn(run, s);
    expect(res.value).toBe('final answer');
  });

  test('subscriber outage plus pane_not_found seals pane-died', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => { s.gone = true; s.handlers.onClose(new HerdrUnavailableError('down')); });
    const res = await runSpawn(run, s);
    expect(String(res.err && res.err.message)).toContain('reason=pane-died');
    expect(res.log).toMatch(/\[herdr-runner\] subscriber down \d+ms, reconciling/);
    expect(res.log).not.toContain('Command failed: herdr pane.get pane_not_found');
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=pane-died');
  });

  test('subscriber outage with the pane alive keeps waiting for the sentinel', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => { s.handlers.onClose(new HerdrUnavailableError('down')); setTimeout(() => writeSentinel(s, run), 80); });
    const res = await runSpawn(run, s);
    expect(res.value).toBe('final answer');
    expect(res.log).toContain('subscriber down');
  });

  test('reconnect with the token gone seals herdr-restart and never closes the pane', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => { s.tokens = {}; s.handlers.onOpen(); });
    const res = await runSpawn(run, s);
    expect(String(res.err && res.err.message)).toContain('reason=herdr-restart');
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=herdr-restart');
    expect(closes(s)).toHaveLength(0);
    expect(fs.existsSync(path.join(run.runDir, 'runner.json'))).toBe(false);
  });

  test('reconnect with the token intact keeps waiting', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => { s.handlers.onOpen(); setTimeout(() => writeSentinel(s, run), 100); });
    const res = await runSpawn(run, s);
    expect(res.value).toBe('final answer');
    expect(outboxLines(run).filter((l) => JSON.stringify(l.body).includes('herdr-restart'))).toHaveLength(0);
  });

  test('hard timeout seals timeout, logs the timeout line and closes through the checked close', async () => {
    const run = mkRun();
    const s = makeStub();
    const res = await runSpawn(run, s, { timeoutMs: 400 });
    expect(String(res.err && res.err.message)).toMatch(/spawnHeadless timed out after \d+ms \(sid=.*, pane=w1:p1, reason=timeout\)/);
    expect(res.log).toContain('spawnHeadless timed out after');
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=timeout');
    expect(closes(s)).toHaveLength(1);
    expect(fs.existsSync(path.join(run.runDir, 'runner.json'))).toBe(false);
  });

  test('timeout with a foreign token on the pane logs token-mismatch and does not close', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.get'] = () => ({ type: 'pane_info', pane: { pane_id: 'w1:p1', tokens: { advisor_sid: 'someone-else' } } });
    const res = await runSpawn(run, s, { timeoutMs: 400 });
    expect(res.err).toBeDefined();
    expect(closes(s)).toHaveLength(0);
  });

  test('a failed socket call logs "Command failed: herdr <method> <code>" and seals unexpected', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.send_text'] = () => { throw new HerdrError('boom_code', 'x'); };
    const res = await runSpawn(run, s);
    expect(res.err).toBeDefined();
    expect(res.log).toContain('Command failed: herdr pane.send_text boom_code');
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=unexpected');
  });

  test('a failed ping logs unavailable, aborts before subscribing and seals unexpected', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks.ping = () => { throw new HerdrUnavailableError('no socket'); };
    const res = await runSpawn(run, s);
    expect(res.err).toBeDefined();
    expect(res.log).toContain('Command failed: herdr ping unavailable');
    expect(methods(s)).not.toContain('events.subscribe');
    expect(JSON.stringify(outboxLines(run)[0].body)).toContain('reason=unexpected');
  });
});

describe('CLI --run SIGTERM', () => {
  test('clears runner.json and leaves the pane open', async () => {
    const fake = await startFakeHerdr({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }], tabs: [{ tab_id: 'w1:t1', label: 'advisor', number: 1 }] });
    try {
      const run = mkRun();
      const child = spawn(process.execPath, [SCRIPT, '--sid', run.sid, '--run', '--agent', 'coder', '--launch-script', run.launchScript, '--prompt-file', run.promptFile, '--timeout-ms', '60000', '--pane-id', 'w1:p1', '--tab-id', 'w1:t1', '--workspace-id', 'w1'], {
        env: { ...process.env, HOME: path.join(tmp, 'home'), ADVISOR_NO_REAPER: '1', HERDR_SOCKET_PATH: fake.socketPath, ADVISOR_CAPTURE_TIMEOUT_MS: '300' },
        stdio: 'ignore',
      });
      const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
      const rec = path.join(run.runDir, 'runner.json');
      expect(await waitFor(() => fs.existsSync(rec))).toBe(true);
      child.kill('SIGTERM');
      await exited;
      expect(fs.existsSync(rec)).toBe(false);
      expect(fake.calls.filter((c) => c.method === 'pane.close')).toHaveLength(0);
      const alive = await createClient({ socketPath: fake.socketPath }).request('pane.get', { pane_id: 'w1:p1' });
      expect(alive.pane.pane_id).toBe('w1:p1');
    } finally {
      await fake.stop();
    }
  }, 20000);
});

describe('--launch-from-meta', () => {
  const metaFor = (runs) => ({ sessions: runs.map((r) => ({ sid: r.sid, launchScript: r.launchScript, promptFile: r.promptFile })) });

  test('env strip: the detached child env lacks the stripped names', async () => {
    const fake = await startFakeHerdr();
    try {
      const run = mkRun();
      const spawned = [];
      const env = { HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: 'w1', PATH: process.env.PATH };
      for (const k of STRIP) env[k] = 'leak';
      await R().runLaunchFromMeta({
        meta: metaFor([run]), agent: 'coder', timeoutMs: 1000, env, lockDir: path.join(tmp, 'lock-env'),
        client: createClient({ socketPath: fake.socketPath }),
        spawner: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; },
      });
      expect(spawned).toHaveLength(1);
      for (const k of STRIP) expect(spawned[0].opts.env[k]).toBeUndefined();
      expect(spawned[0].opts.env.HERDR_SOCKET_PATH).toBe(fake.socketPath);
      expect(spawned[0].opts.env.ADVISOR_NO_REAPER).toBe('1');
      expect(spawned[0].opts.detached).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test('a 3-session META allocates one ensemble tab and spawns 3 --run children with argv starting --sid', async () => {
    const fake = await startFakeHerdr();
    try {
      const runs = [mkRun(), mkRun(), mkRun()];
      const spawned = [];
      await R().runLaunchFromMeta({
        meta: metaFor(runs), agent: 'coder', timeoutMs: 1500,
        env: { HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: 'w1', PATH: process.env.PATH },
        lockDir: path.join(tmp, 'lock-ens'), client: createClient({ socketPath: fake.socketPath }),
        spawner: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; },
      });
      const creates = fake.calls.filter((c) => c.method === 'tab.create');
      expect(creates).toHaveLength(1);
      expect(creates[0].params.label).toMatch(/^ensemble-3-\d{8}$/);
      expect(fake.calls.filter((c) => c.method === 'pane.split')).toHaveLength(2);
      expect(spawned).toHaveLength(3);
      const panes = new Set();
      spawned.forEach((sp, i) => {
        expect(sp.args[0]).toBe(SCRIPT);
        expect(sp.args.slice(1, 4)).toEqual(['--sid', runs[i].sid, '--run']);
        const get = (f) => sp.args[sp.args.indexOf(f) + 1];
        expect(get('--launch-script')).toBe(runs[i].launchScript);
        expect(get('--prompt-file')).toBe(runs[i].promptFile);
        expect(get('--timeout-ms')).toBe('1500');
        expect(get('--workspace-id')).toBe('w1');
        panes.add(get('--pane-id'));
      });
      expect(panes.size).toBe(3);
    } finally {
      await fake.stop();
    }
  });

  test('CLI: spawns detached children that log to herdr-runner.log and exits 0', async () => {
    const fake = await startFakeHerdr();
    try {
      const runs = [mkRun(), mkRun()];
      const res = await runCli(['--launch-from-meta', '--agent', 'coder', '--timeout-ms', '1500'], {
        input: JSON.stringify(metaFor(runs)),
        env: { HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: 'w1', ADVISOR_CAPTURE_TIMEOUT_MS: '200' },
      });
      expect(res.code).toBe(0);
      for (const r of runs) {
        const log = path.join(r.runDir, 'herdr-runner.log');
        const ok = await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(`[herdr-runner] spawn sid=${r.sid} pane=`));
        expect(ok).toBe(true);
      }
      await waitFor(() => runs.every((r) => fs.readFileSync(path.join(r.runDir, 'herdr-runner.log'), 'utf8').includes('timed out after')), 10000);
    } finally {
      await fake.stop();
    }
  }, 30000);
});

describe('CLI --close, --close-self, --pane-state', () => {
  test('--close closes only the token-matching pane, prints JSON, exits 0', async () => {
    const run = mkRun();
    const fake = await startFakeHerdr({ panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: run.sid } },
      { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'other' } },
      { pane_id: 'w1:p3', tab_id: 'w1:t1' },
    ] });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath, ADVISOR_RUNS_ROOT: path.dirname(run.runDir) };
      const res = await runCli(['--close', '--sid', run.sid], { env });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout.trim().split('\n').pop())).toEqual({ closed: ['w1:p1'], refused: [] });
      expect(fake.calls.filter((c) => c.method === 'pane.close').map((c) => c.params.pane_id)).toEqual(['w1:p1']);
    } finally {
      await fake.stop();
    }
  }, 20000);

  test('--close exits 0 with nothing closed when the socket is unreachable', async () => {
    const run = mkRun();
    const res = await runCli(['--close', '--sid', run.sid], { env: { HERDR_SOCKET_PATH: path.join(tmp, 'nope.sock'), ADVISOR_RUNS_ROOT: path.dirname(run.runDir) } });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()).closed).toEqual([]);
  }, 20000);

  test('--close falls back to runner.json socket_path when HERDR_SOCKET_PATH is unset', async () => {
    const run = mkRun();
    const fake = await startFakeHerdr({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: run.sid } }] });
    try {
      fs.writeFileSync(path.join(run.runDir, 'runner.json'), JSON.stringify({ pid: 0, backend: 'herdr', pane_id: 'w1:p1', socket_path: fake.socketPath }));
      const res = await runCli(['--close', '--sid', run.sid], { env: { ADVISOR_RUNS_ROOT: path.dirname(run.runDir) } });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout.trim().split('\n').pop()).closed).toEqual(['w1:p1']);
    } finally {
      await fake.stop();
    }
  }, 20000);

  test('--close-self closes only the own tokened pane; mismatch and missing env close nothing; exit 0 always', async () => {
    const fake = await startFakeHerdr({ panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: 'mine' } },
      { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 'other' } },
    ] });
    try {
      const base = { HERDR_SOCKET_PATH: fake.socketPath };
      const bad = await runCli(['--close-self'], { env: { ...base, HERDR_PANE_ID: 'w1:p2', ADVISOR_SID: 'mine' } });
      const none = await runCli(['--close-self'], { env: base });
      expect([bad.code, none.code]).toEqual([0, 0]);
      expect(fake.calls.filter((c) => c.method === 'pane.close')).toHaveLength(0);
      const ok = await runCli(['--close-self'], { env: { ...base, HERDR_PANE_ID: 'w1:p1', ADVISOR_SID: 'mine' } });
      expect(ok.code).toBe(0);
      expect(fake.calls.filter((c) => c.method === 'pane.close').map((c) => c.params.pane_id)).toEqual(['w1:p1']);
    } finally {
      await fake.stop();
    }
  }, 20000);

  test('--pane-state prints alive, gone, no-record and unknown', async () => {
    const fake = await startFakeHerdr({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] });
    try {
      const state = async (paneId, socket) => {
        const run = mkRun();
        if (paneId) fs.writeFileSync(path.join(run.runDir, 'runner.json'), JSON.stringify({ pid: 1, backend: 'herdr', pane_id: paneId, socket_path: socket }));
        const res = await runCli(['--pane-state', '--sid', run.sid], { env: { HERDR_SOCKET_PATH: socket, ADVISOR_RUNS_ROOT: path.dirname(run.runDir) } });
        expect(res.code).toBe(0);
        return JSON.parse(res.stdout.trim().split('\n').pop());
      };
      expect(await state('w1:p1', fake.socketPath)).toEqual({ state: 'alive', pane_id: 'w1:p1' });
      expect(await state('w1:p9', fake.socketPath)).toEqual({ state: 'gone', pane_id: 'w1:p9' });
      expect((await state(null, fake.socketPath)).state).toBe('no-record');
      expect(await state('w1:p1', path.join(tmp, 'nope.sock'))).toEqual({ state: 'unknown', pane_id: 'w1:p1' });
    } finally {
      await fake.stop();
    }
  }, 30000);
});

describe('fix round 1: D2 marker, D4 log grammar, M1 untokened close, m3 guard', () => {
  test('D2: writes runs/<sid>/backend "herdr\\n" before runner.json and keeps it after the run', async () => {
    const run = mkRun();
    const s = makeStub();
    const marker = path.join(run.runDir, 'backend');
    const rec = path.join(run.runDir, 'runner.json');
    let atPing = null;
    s.hooks.ping = () => { atPing = { marker: fs.existsSync(marker), rec: fs.existsSync(rec) }; return undefined; };
    onSend(s, 2, () => writeSentinel(s, run));
    const res = await runSpawn(run, s);
    expect(res.err).toBeUndefined();
    expect(atPing).toEqual({ marker: true, rec: false });
    expect(fs.existsSync(rec)).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('herdr\n');
  });

  test('D4: pane-died ends with the worker-ended line, never the timeout prefix', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => s.emitExit());
    const res = await runSpawn(run, s);
    expect(String(res.err && res.err.message)).not.toContain('timed out after');
    expect(res.log).not.toContain('timed out after');
    expect(res.log).toContain(`[herdr-runner] worker ended reason=pane-died sid=${run.sid} pane=w1:p1`);
  });

  test('D4: herdr-restart ends with the worker-ended line, never the timeout prefix', async () => {
    const run = mkRun();
    const s = makeStub();
    onSend(s, 2, () => { s.tokens = {}; s.handlers.onClose(); });
    const res = await runSpawn(run, s);
    expect(res.log).not.toContain('timed out after');
    expect(res.log).toContain(`[herdr-runner] worker ended reason=herdr-restart sid=${run.sid} pane=w1:p1`);
  });

  test('D4: an unexpected failure logs the worker-ended line', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.send_text'] = () => { throw new HerdrError('boom_code', 'x'); };
    const res = await runSpawn(run, s);
    expect(res.log).toContain(`[herdr-runner] worker ended reason=unexpected sid=${run.sid} pane=w1:p1`);
  });

  test('D4: a hard timeout still logs the timeout prefix', async () => {
    const run = mkRun();
    const res = await runSpawn(run, makeStub(), { timeoutMs: 400 });
    expect(res.log).toContain('spawnHeadless timed out after');
    expect(res.log).toContain('reason=timeout');
  });

  test('D4: an expected pane_not_found in reconcile and readiness is not logged as Command failed', async () => {
    const run = mkRun();
    const s = makeStub({ agentStatus: 'working' });
    let reads = 0;
    s.hooks['pane.read'] = () => { if (reads++ === 0) throw new HerdrError('pane_not_found', 'gone'); return undefined; };
    onSend(s, 2, () => { s.gone = true; s.handlers.onClose(); });
    const res = await runSpawn(run, s, { env: { HERDR_BIN_PATH: '/x/herdr', HERDR_SOCKET_PATH: '/x/sock', ADVISOR_CAPTURE_TIMEOUT_MS: '300' } });
    expect(res.err).toBeDefined();
    expect(res.log).not.toContain('Command failed: herdr pane.get pane_not_found');
    expect(res.log).not.toContain('Command failed: herdr pane.read pane_not_found');
  });

  test('M1: a hard timeout never closes a pane whose token is gone', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['agent.prompt'] = () => { setTimeout(() => { s.tokens = {}; }, 200); return undefined; };
    const res = await runSpawn(run, s, { timeoutMs: 600 });
    expect(res.err).toBeDefined();
    expect(closes(s)).toHaveLength(0);
  });

  test('M1: an unexpected failure never closes a pane whose token is gone', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.send_text'] = () => { s.tokens = {}; throw new HerdrError('boom_code', 'x'); };
    const res = await runSpawn(run, s);
    expect(res.err).toBeDefined();
    expect(closes(s)).toHaveLength(0);
  });

  test('m3: a pane_exited during the launch send stops before the Enter key', async () => {
    const run = mkRun();
    const s = makeStub();
    s.hooks['pane.send_text'] = () => { s.emitExit(); return undefined; };
    const res = await runSpawn(run, s);
    expect(res.err).toBeDefined();
    expect(methods(s)).toContain('pane.send_text');
    expect(methods(s)).not.toContain('pane.send_keys');
  });
});

describe('fix round 1: D6 orphan panes, m2 sid validation, m4 usage, m5 live socket', () => {
  const metaFor = (runs) => ({ sessions: runs.map((r) => ({ sid: r.sid, launchScript: r.launchScript, promptFile: r.promptFile })) });
  const launchEnv = (fake) => ({ HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: 'w1', PATH: process.env.PATH, ADVISOR_RUNS_ROOT: path.join(tmp, 'runs') });

  test('D6: every allocated pane is tagged before the first child spawns', async () => {
    const fake = await startFakeHerdr();
    try {
      const runs = [mkRun(), mkRun(), mkRun()];
      let taggedAtFirstSpawn = null;
      await R().runLaunchFromMeta({
        meta: metaFor(runs), agent: 'coder', timeoutMs: 1500, env: launchEnv(fake),
        lockDir: path.join(tmp, 'lock-d6a'), client: createClient({ socketPath: fake.socketPath }),
        spawner: () => {
          if (taggedAtFirstSpawn === null) taggedAtFirstSpawn = fake.calls.filter((c) => c.method === 'pane.report_metadata').map((c) => c.params.tokens.advisor_sid);
          return { unref() {} };
        },
      });
      expect(taggedAtFirstSpawn.sort()).toEqual(runs.map((r) => r.sid).sort());
    } finally {
      await fake.stop();
    }
  });

  test('D6: a spawner failure for session 2 of 3 still leaves all 3 panes tagged', async () => {
    const fake = await startFakeHerdr();
    try {
      const runs = [mkRun(), mkRun(), mkRun()];
      let n = 0;
      await expect(R().runLaunchFromMeta({
        meta: metaFor(runs), agent: 'coder', timeoutMs: 1500, env: launchEnv(fake),
        lockDir: path.join(tmp, 'lock-d6b'), client: createClient({ socketPath: fake.socketPath }),
        spawner: () => { if (++n === 2) throw new Error('spawn boom'); return { unref() {} }; },
      })).rejects.toThrow('spawn boom');
      expect(fake.calls.filter((c) => c.method === 'pane.report_metadata')).toHaveLength(3);
    } finally {
      await fake.stop();
    }
  });

  test('D6: the orphan reaper runs (pane.list) before any pane is allocated', async () => {
    const fake = await startFakeHerdr();
    try {
      await R().runLaunchFromMeta({
        meta: metaFor([mkRun()]), agent: 'coder', timeoutMs: 1500, env: launchEnv(fake),
        lockDir: path.join(tmp, 'lock-d6c'), client: createClient({ socketPath: fake.socketPath }),
        spawner: () => ({ unref() {} }),
      });
      const ms = fake.calls.map((c) => c.method);
      expect(ms).toContain('pane.list');
      expect(ms.indexOf('pane.list')).toBeLessThan(Math.min(...['tab.create', 'pane.split'].map((m) => (ms.includes(m) ? ms.indexOf(m) : Infinity))));
    } finally {
      await fake.stop();
    }
  });

  test('m2: --pane-state and --close refuse a --sid that escapes the runs root', async () => {
    const run = mkRun();
    const evil = path.join(tmp, 'runs-evil');
    fs.mkdirSync(evil, { recursive: true });
    const fake = await startFakeHerdr({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: '../runs-evil' } }] });
    try {
      fs.writeFileSync(path.join(evil, 'runner.json'), JSON.stringify({ pid: 1, backend: 'herdr', pane_id: 'w1:p1', socket_path: fake.socketPath }));
      const env = { HERDR_SOCKET_PATH: fake.socketPath, ADVISOR_RUNS_ROOT: path.dirname(run.runDir) };
      const st = await runCli(['--pane-state', '--sid', '../runs-evil'], { env });
      expect(st.code).toBe(0);
      expect(JSON.parse(st.stdout.trim().split('\n').pop())).toEqual({ state: 'no-record', pane_id: null });
      const cl = await runCli(['--close', '--sid', '../runs-evil'], { env });
      expect(cl.code).toBe(0);
      expect(JSON.parse(cl.stdout.trim().split('\n').pop())).toEqual({ closed: [], refused: [{ paneId: '', reason: 'invalid-sid' }] });
      expect(fake.calls.filter((c) => c.method === 'pane.close')).toHaveLength(0);
    } finally {
      await fake.stop();
    }
  }, 20000);

  test('m2: --close refuses every malformed --sid form (dot, empty, embedded slash, absolute)', async () => {
    const run = mkRun();
    const fake = await startFakeHerdr({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: { advisor_sid: '.' } }] });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath, ADVISOR_RUNS_ROOT: path.dirname(run.runDir) };
      for (const bad of ['.', '..', '', 'a/b', '/abs/sid']) {
        const res = await runCli(['--close', '--sid', bad], { env });
        expect(res.code).toBe(0);
        expect(JSON.parse(res.stdout.trim().split('\n').pop())).toEqual({ closed: [], refused: [{ paneId: '', reason: 'invalid-sid' }] });
      }
      expect(fake.calls.filter((c) => c.method === 'pane.close')).toHaveLength(0);
    } finally {
      await fake.stop();
    }
  }, 30000);

  test('m4: the usage text documents that --agent and --tui have no effect on placement', async () => {
    const res = await runCli([]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--tui');
    expect(res.stderr).toMatch(/--agent and --tui .*no effect/);
  });

  test('m5: the live test derives its default socket from HOME, not a hard-coded user path', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, 'herdr-live.test.js'), 'utf8');
    const line = src.split('\n').find((l) => l.startsWith('const DEFAULT_SOCK'));
    expect(line).toBeDefined();
    expect(line).not.toContain('/Users/');
    expect(line).toContain('HOME');
  });
});

describe('CLAUDE_READY_RE', () => {
  test('matches claude idle footer, not a bare shell prompt', () => {
    const { CLAUDE_READY_RE } = require('../lib/herdr-runner.js');
    expect(CLAUDE_READY_RE.test('  ? for shortcuts')).toBe(true);
    expect(CLAUDE_READY_RE.test('> Try "fix lint errors"')).toBe(true);
    expect(CLAUDE_READY_RE.test('awesome@host ~/repo % ')).toBe(false);
    expect(CLAUDE_READY_RE.test('')).toBe(false);
  });
});
