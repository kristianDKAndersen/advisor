'use strict';
// Per-worker supervising process for the herdr backend: spawns the worker in a pane, tags it,
// writes runner.json, sends launch command and prompt, and supervises until the outbox result,
// pane exit, subscriber outage or hard timeout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// lib/tmux-runner.js runs its module-load reapers unless this is set before the require.
if (process.env.ADVISOR_NO_REAPER == null || process.env.ADVISOR_NO_REAPER === '') process.env.ADVISOR_NO_REAPER = '1';

const {
  pollSentinel, ensureStopHook, parseTranscript, writeRunnerRecord, clearRunnerRecord, readOwnerSessionId,
} = require('./tmux-runner');
const { appendSyntheticIfAbsent, syntheticResultBody } = require('./channel');
const { resolveSocketPath, resolveHerdrBin } = require('./worker-backend');
const { createClient } = require('./herdr-client');
const panes = require('./herdr-panes');

const HERDR_STRIP_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'SSE_PORT', 'CHILD_SESSION', 'ENTRYPOINT'];
// A herdr pane already shows a shell prompt, so "any text" is not readiness. This is
// claude's idle footer, proven live on herdr 0.9.5 (live test T3, run 1793872102-0471d9).
const CLAUDE_READY_RE = /for shortcuts|Try "/;
// Socket spelling of Enter for pane.send_keys is unverified (taken from the CLI); the live test corrects it here.
const ENTER_KEY = 'enter';
const SID_TOKEN_MAX = 80;
const RECONCILE_INTERVAL_MS = 1000;

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stderr.write(line + '\n');
const failCode = (err) => (err && err.code ? err.code : 'unavailable');

// D2: persistent marker that close-worker-tab reads; written before runner.json and never deleted.
function writeBackendMarker(runDir) {
  fs.writeFileSync(path.join(runDir, 'backend'), 'herdr\n');
}

function buildLaunchCommand({ sid, sentinel, launchScript }) {
  const unset = HERDR_STRIP_ENV.map((k) => `-u ${k}`).join(' ');
  return `ADVISOR_WORKER_BACKEND=herdr ADVISOR_SID=${shq(sid)} CLAUDE_I_SENTINEL=${shq(sentinel)} exec env ${unset} bash ${shq(launchScript)}`;
}

// Returns the body of the first 'result' line in the outbox, or null when there is none.
function readOutboxResult(outboxPath) {
  let raw;
  try { raw = fs.readFileSync(outboxPath, 'utf8'); } catch (_) { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg && msg.type === 'result') return typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body === undefined ? '' : msg.body);
    } catch (_) { /* skip malformed line */ }
  }
  return null;
}

async function spawnHeadlessHerdr({
  sid, agent, launchScript, promptFile, timeoutMs = 300000, paneId, tabId, workspaceId,
  client, env = process.env, clock, promptInArgv = false,
}) {
  const clk = clock || { now: () => Date.now(), sleep };
  const startTs = clk.now();
  const runDir = path.dirname(launchScript);
  const outboxPath = path.join(runDir, 'channel', 'outbox.jsonl');
  const sentinel = path.join(os.tmpdir(), `claude-i-${crypto.randomBytes(8).toString('hex')}.done`);
  const sentinelJson = sentinel + '.json';
  const want = sid.slice(0, SID_TOKEN_MAX);

  const sealOutbox = (reason) => {
    try {
      appendSyntheticIfAbsent(outboxPath, {
        type: 'result',
        body: syntheticResultBody(sid, `worker exited without result (exit_code=unknown); reason=${reason}`),
        from: 'wrapper',
      });
    } catch (_) { /* fail-open */ }
  };
  // D4: the classifier reads "timed out after" as hit-timeout, so only reason=timeout may carry it.
  const endedLine = (reason) => `[herdr-runner] worker ended reason=${reason} sid=${sid} pane=${paneId}`;
  const failure = (reason) => new Error(reason === 'timeout'
    ? `spawnHeadless timed out after ${clk.now() - startTs}ms (sid=${sid}, pane=${paneId}, reason=${reason})`
    : endedLine(reason));

  let raw = client;
  let sub = null;
  let finished = false;
  let tagged = false;
  let reconciling = false;
  let settledReason = null;
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const finish = (reason) => { if (!settledReason) { settledReason = reason; settle(reason); } };

  // Every failed socket call is logged in the classifier grammar.
  const lc = {
    request: async (method, params) => {
      try { return await raw.request(method, params); } catch (err) {
        const expected = err && err.code === 'pane_not_found' && (method === 'pane.get' || method === 'pane.read');
        if (!expected) log(`Command failed: herdr ${method} ${failCode(err)}`);
        throw err;
      }
    },
  };

  const onPaneGone = () => {
    const has = readOutboxResult(outboxPath) !== null;
    log(`[herdr-runner] pane_exited sid=${sid} pane=${paneId} result_in_outbox=${has}`);
    finish(has ? 'exited-with-result' : 'pane-died');
  };

  async function reconcile() {
    if (finished || settledReason || reconciling) return;
    reconciling = true;
    try {
      let res;
      try { res = await lc.request('pane.get', { pane_id: paneId }); } catch (err) {
        if (err && err.code === 'pane_not_found') onPaneGone();
        return;
      }
      if (!tagged) return;
      const pane = (res && res.pane) || res || {};
      const tok = pane.tokens && pane.tokens.advisor_sid;
      if (tok === undefined || tok === null || tok === '') {
        log(`[herdr-runner] token lost sid=${sid} pane=${paneId}`);
        finish('herdr-restart');
      } else if (tok !== want) {
        log(`[herdr-runner] token-mismatch sid=${sid} pane=${paneId}`);
        finish('pane-died');
      }
    } finally {
      reconciling = false;
    }
  }

  const cleanup = async (closePane) => {
    finished = true;
    if (sub) { try { sub.close(); } catch (_) { /* ignore */ } }
    if (closePane) {
      try { await panes.closePaneChecked({ client: lc, sid, paneId, runDir }); } catch (_) { /* fail-open */ }
    }
    try { fs.unlinkSync(sentinel); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(sentinelJson); } catch (_) { /* ignore */ }
    clearRunnerRecord(runDir);
  };

  const guard = () => { if (settledReason) throw new Error('settled'); };

  // Pane ids are reused across herdr restarts: call this immediately before every input call.
  // A missing or foreign token ends the run with nothing sent; a failed lookup propagates.
  async function verifyToken() {
    guard();
    let got;
    try { got = await lc.request('pane.get', { pane_id: paneId }); } catch (err) {
      if (err && err.code === 'pane_not_found') onPaneGone();
      throw err;
    }
    const tok = (((got && got.pane) || got || {}).tokens || {}).advisor_sid;
    if (tok !== want) {
      log(`[herdr-runner] ${tok ? 'token-mismatch' : 'token missing'} sid=${sid} pane=${paneId}`);
      finish('herdr-restart');
    }
    guard();
  }

  async function provision() {
    const promptContent = fs.readFileSync(promptFile, 'utf8');
    writeBackendMarker(runDir);
    if (!raw) raw = createClient({ socketPath: resolveSocketPath(env) });
    const pong = await lc.request('ping', {});
    log(`[herdr-runner] herdr_bin=${resolveHerdrBin(env)} protocol=${pong && pong.protocol}`);
    ensureStopHook();

    let lastOk = clk.now();
    // An API pane.close emits pane_closed, not pane_exited: either one means the pane is gone.
    sub = raw.subscribe([{ type: 'pane.exited' }, { type: 'pane.closed' }], {
      onEvent: (evt) => {
        lastOk = clk.now();
        if ((evt.event === 'pane_exited' || evt.event === 'pane_closed') && evt.paneId === paneId) onPaneGone();
      },
      onOpen: () => { lastOk = clk.now(); reconcile(); },
      onClose: () => {
        log(`[herdr-runner] subscriber down ${clk.now() - lastOk}ms, reconciling`);
        reconcile();
      },
    });
    await sub.ready;
    guard();

    // D7: placement tagged this pane; verify it, never stamp. A missing or foreign token means the id was reused.
    const got = await lc.request('pane.get', { pane_id: paneId });
    const tok = (((got && got.pane) || got || {}).tokens || {}).advisor_sid;
    if (tok !== want) {
      log(`[herdr-runner] ${tok ? 'token-mismatch' : 'token missing'} sid=${sid} pane=${paneId}`);
      finish('herdr-restart');
    }
    tagged = true;
    guard();
    let socketPath = null;
    try { socketPath = resolveSocketPath(env); } catch (_) { /* stubbed client */ }
    writeRunnerRecord(runDir, {
      pid: process.pid, mode: 'herdr', backend: 'herdr', pane_id: paneId, tab_id: tabId, workspace_id: workspaceId,
      socket_path: socketPath, herdr_bin: resolveHerdrBin(env), started_at: startTs,
    });
    log(`[herdr-runner] spawn sid=${sid} pane=${paneId} tab=${tabId} ws=${workspaceId}`);

    await verifyToken();
    await lc.request('pane.send_text', { pane_id: paneId, text: buildLaunchCommand({ sid, sentinel, launchScript }) });
    guard();
    await verifyToken();
    await lc.request('pane.send_keys', { pane_id: paneId, keys: [ENTER_KEY] });
    guard();

    // D9: summon's launch.sh already carries the prompt in claude's argv, so there is nothing to wait for or type.
    if (!promptInArgv) {
      const waitMs = parseInt(env.ADVISOR_CAPTURE_TIMEOUT_MS || '30000', 10) || 30000;
      const goneOnNotFound = (err) => { if (err && err.code === 'pane_not_found') onPaneGone(); };
      // Primary readiness: herdr detects the claude agent and reports it idle. Polled on `raw`
      // so the expected not-yet-detected errors do not flood the failure log.
      let readiness = 'timeout';
      const agentDeadline = clk.now() + waitMs;
      while (clk.now() < agentDeadline) {
        guard();
        try {
          const res = await raw.request('agent.get', { target: paneId });
          const a = (res && res.agent) || {};
          if (a.agent && (a.agent_status === 'idle' || a.agent_status === 'done') && a.interactive_ready !== false) { readiness = 'agent'; break; }
        } catch (err) { goneOnNotFound(err); /* else no agent detected yet */ }
        await clk.sleep(200);
      }
      if (readiness !== 'agent') {
        const footerDeadline = clk.now() + waitMs;
        while (clk.now() < footerDeadline) {
          guard();
          try {
            const res = await lc.request('pane.read', { pane_id: paneId, source: 'visible' });
            if (CLAUDE_READY_RE.test(((res && res.read) || {}).text || '')) { readiness = 'footer-fallback'; break; }
          } catch (err) { goneOnNotFound(err); /* else logged; keep polling */ }
          await clk.sleep(200);
        }
      }
      guard();
      if (readiness === 'timeout') {
        // A busy worker never shows idle: no input, no close, just keep supervising.
        log(`[herdr-runner] readiness=timeout, continuing sid=${sid} pane=${paneId}`);
      } else {
        log(`[herdr-runner] readiness=${readiness} sid=${sid} pane=${paneId}`);
        // One ordered submission (bracketed paste + Enter). A failure is never retried: input may be partly written.
        await verifyToken();
        await lc.request('agent.prompt', { target: paneId, text: promptContent });
        guard();
      }
    }

    const remaining = Math.max(0, timeoutMs - (clk.now() - startTs));
    const checkAlive = () => {
      if (finished || settledReason) throw new Error('done');
      reconcile();
    };
    const done = await pollSentinel(sentinel, remaining, 200, runDir, checkAlive, RECONCILE_INTERVAL_MS, readOwnerSessionId(runDir));
    return done ? 'sentinel' : 'timeout';
  }

  const timer = setTimeout(() => finish('timeout'), timeoutMs);
  let reason;
  try {
    reason = await Promise.race([
      settled,
      provision().catch((err) => { if (err && err.message === 'settled') return settled; throw err; }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    log(endedLine('unexpected') + ((err && err.endedSuffix) || ''));
    await cleanup(true);
    sealOutbox('unexpected');
    throw err;
  }
  clearTimeout(timer);

  if (reason === 'sentinel') {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(sentinelJson, 'utf8')); } catch (err) {
      log(endedLine('stop-hook-but-no-result'));
      await cleanup(true);
      sealOutbox('stop-hook-but-no-result');
      throw new Error(`Failed to parse Stop hook payload: ${err.message}`);
    }
    if (!payload.transcript_path) {
      log(endedLine('stop-hook-but-no-result'));
      await cleanup(true);
      sealOutbox('stop-hook-but-no-result');
      throw new Error('Stop hook payload missing transcript_path');
    }
    const result = parseTranscript(payload.transcript_path);
    await cleanup(true);
    sealOutbox('no-op-success');
    return result;
  }
  if (reason === 'exited-with-result') {
    await cleanup(false);
    return readOutboxResult(outboxPath);
  }
  if (reason === 'pane-died' || reason === 'herdr-restart') {
    await cleanup(false);
    sealOutbox(reason);
    const err = failure(reason);
    log(err.message);
    throw err;
  }
  // timeout: a pane that is already gone is reported as pane-died, otherwise close it through the checked close.
  const state = await panes.paneState(lc, paneId);
  const stopReason = state === 'gone' ? 'pane-died' : 'timeout';
  await cleanup(state !== 'gone');
  sealOutbox(stopReason);
  const err = failure(stopReason);
  log(err.message);
  throw err;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function runsRoot(env) {
  return (env && env.ADVISOR_RUNS_ROOT) || path.join(os.homedir(), '.advisor', 'runs');
}

function stripEnv(env) {
  const out = { ...env };
  for (const k of HERDR_STRIP_ENV) delete out[k];
  out.ADVISOR_NO_REAPER = '1';
  return out;
}

async function runLaunchFromMeta({ meta, agent, timeoutMs, env = process.env, client, lockDir, spawner = spawn }) {
  const sessions = meta.sessions || [meta];
  const sids = sessions.map((s) => s.sid);
  const lock = lockDir || path.join(os.tmpdir(), 'advisor-herdr-lock');
  const cwd = process.cwd();
  const cl = client || createClient({ socketPath: resolveSocketPath(env) });
  try { await panes.reapOrphanHerdrPanes({ client: cl, runsDir: runsRoot(env) }); } catch (_) { /* best-effort */ }
  let allocated;
  if (sessions.length > 1) {
    allocated = await panes.allocateEnsemblePanes({ client: cl, env, sids, lockDir: lock, cwd });
  } else {
    const p = await panes.ensureWorkerPane({ client: cl, env, sid: sids[0], agent, lockDir: lock, cwd });
    allocated = [{ sid: sids[0], ...p }];
  }
  // D7: placement tags each pane; a child starts only for a tagged one, and an untagged one is sealed.
  for (const s of sessions) {
    const a = allocated.find((x) => x.sid === s.sid);
    const runDir = path.dirname(s.launchScript);
    writeBackendMarker(runDir);
    if (!a || a.tagged !== true) {
      const te = a && a.tagError;
      log(`Command failed: herdr pane.report_metadata ${(te && (te.code || (te.cause && te.cause.code))) || 'tag-verify-failed'}`);
      try {
        appendSyntheticIfAbsent(path.join(runDir, 'channel', 'outbox.jsonl'), {
          type: 'result',
          body: syntheticResultBody(s.sid, 'worker exited without result (exit_code=unknown); reason=unexpected'),
          from: 'wrapper',
        });
      } catch (_) { /* fail-open */ }
      continue;
    }
    const args = [__filename, '--sid', s.sid, '--run', '--agent', agent, '--launch-script', s.launchScript,
      '--prompt-file', s.promptFile, '--timeout-ms', String(timeoutMs), '--pane-id', a.paneId, '--tab-id', a.tabId, '--workspace-id', a.workspaceId];
    const fd = fs.openSync(path.join(path.dirname(s.launchScript), 'herdr-runner.log'), 'a');
    try {
      const child = spawner(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: stripEnv(env) });
      child.unref();
    } finally {
      fs.closeSync(fd);
    }
  }
  return allocated;
}

// Socket for the close and probe modes: HERDR_SOCKET_PATH, else the runner.json socket_path, else null.
function socketFor(env, runDir) {
  try { return resolveSocketPath(env); } catch (_) { /* fall through */ }
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'runner.json'), 'utf8')).socket_path || null; } catch (_) { return null; }
}

async function main(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const has = (flag) => argv.includes(flag);
  const sid = get('--sid');
  const sidBad = sid !== null && (sid === '' || sid === '.' || sid === '..' || path.basename(sid) !== sid);
  const runDir = sid && !sidBad ? path.join(runsRoot(process.env), sid) : null;
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  if (has('--launch-from-meta')) {
    const meta = JSON.parse(fs.readFileSync(0, 'utf8'));
    try {
      await runLaunchFromMeta({ meta, agent: get('--agent'), timeoutMs: Number(get('--timeout-ms')) || undefined });
      return 0;
    } catch (err) {
      process.stderr.write(`[herdr-runner] launch failed: ${err.message}\n`);
      return 1;
    }
  }
  if (has('--close-self')) {
    try {
      const client = createClient({ socketPath: resolveSocketPath(process.env) });
      out(await panes.closeSelf({ client, env: process.env }));
    } catch (err) {
      out({ closed: false, reason: err.code || 'error' });
    }
    return 0;
  }
  if (sidBad) {
    if (has('--close')) { out({ closed: [], refused: [{ paneId: '', reason: 'invalid-sid' }] }); return 0; }
    if (has('--pane-state')) { out({ state: 'no-record', pane_id: null }); return 0; }
    process.stderr.write('[herdr-runner] invalid --sid\n');
    return 2;
  }
  if (has('--close')) {
    const socketPath = sid && socketFor(process.env, runDir);
    if (!socketPath) { out({ closed: [], refused: [{ paneId: '', reason: 'no-socket' }] }); return 0; }
    try {
      out(await panes.closeWorkerBySid({ client: createClient({ socketPath }), sid, runDir }));
    } catch (err) {
      out({ closed: [], refused: [{ paneId: '', reason: err.code || 'error' }] });
    }
    return 0;
  }
  if (has('--pane-state')) {
    let paneId = null;
    try { paneId = JSON.parse(fs.readFileSync(path.join(runDir, 'runner.json'), 'utf8')).pane_id || null; } catch (_) { /* no record */ }
    const socketPath = sid && socketFor(process.env, runDir);
    let state = 'unknown';
    try {
      state = socketPath ? await panes.probeRunnerPane({ client: createClient({ socketPath }), runDir }) : (paneId ? 'unknown' : 'no-record');
    } catch (_) { /* unknown */ }
    out({ state, pane_id: paneId });
    return 0;
  }
  if (has('--run')) {
    const launchScript = get('--launch-script');
    const promptFile = get('--prompt-file');
    const paneId = get('--pane-id');
    if (!sid || !launchScript || !promptFile || !paneId) {
      process.stderr.write('[herdr-runner] --run requires --sid --launch-script --prompt-file --pane-id\n');
      return 2;
    }
    process.on('SIGTERM', () => { clearRunnerRecord(path.dirname(launchScript)); process.exit(0); });
    try {
      await spawnHeadlessHerdr({
        sid, agent: get('--agent'), launchScript, promptFile, timeoutMs: Number(get('--timeout-ms')) || undefined,
        paneId, tabId: get('--tab-id'), workspaceId: get('--workspace-id'), promptInArgv: true,
      });
      return 0;
    } catch (err) {
      process.stderr.write(`[herdr-runner] exit error: ${err.message}\n`);
      return 1;
    }
  }
  process.stderr.write('usage: herdr-runner.js --sid S --run ... | --launch-from-meta ... | --close --sid S | --close-self | --pane-state --sid S\n'
    + '(--agent and --tui are accepted for summon parity and have no effect on placement)\n');
  return 2;
}

module.exports = { HERDR_STRIP_ENV, ENTER_KEY, CLAUDE_READY_RE, buildLaunchCommand, spawnHeadlessHerdr, runLaunchFromMeta };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`[herdr-runner] fatal: ${err && err.message}\n`);
    process.exit(1);
  });
}
