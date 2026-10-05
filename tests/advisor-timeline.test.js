'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'bin', 'advisor-timeline');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString()
      }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('request timeout')); });
  });
}

async function startServer(extraEnv) {
  const port = await freePort();
  const env = Object.assign({}, process.env, extraEnv);
  const proc = spawn('node', [SERVER, '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout after 8s')), 8000);
    proc.stdout.on('data', data => {
      if (data.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error('server exited with code ' + code)); });
  });

  return {
    port,
    cleanup() { proc.kill('SIGTERM'); }
  };
}

// ── Seed temp filesystem ──────────────────────────────────────────────────────

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-test-home-'));
const fakeSid = 'fake-sid-0001';
const fakeSidDir = path.join(tmpHome, '.advisor', 'runs', fakeSid);
const fakeChannelDir = path.join(fakeSidDir, 'channel');
fs.mkdirSync(fakeChannelDir, { recursive: true });
fs.writeFileSync(path.join(fakeSidDir, 'meta.json'),
  JSON.stringify({ agent: 'test-worker', goal: 'do something' }));
fs.writeFileSync(path.join(fakeSidDir, 'session.json'),
  JSON.stringify({ sid: fakeSid, tier: 1, decomposition: [] }));
fs.writeFileSync(path.join(fakeSidDir, 'synthesis.log'),
  '{"seq":1,"established":"thing1"}\n' +
  '{bad json here\n' +
  '{"seq":2,"established":"thing2"}\n'
);

// A test-session dir that should be filtered out of /api/sessions
const testSessionSid = 'test-session-filter-check';
const testSessionDir = path.join(tmpHome, '.advisor', 'runs', testSessionSid);
fs.mkdirSync(path.join(testSessionDir, 'channel'), { recursive: true });
fs.writeFileSync(path.join(testSessionDir, 'meta.json'),
  JSON.stringify({ agent: 'coder', task: 'Test task T', isTestSession: true }));

const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-test-dist-'));
const tmpAssetsDir = path.join(tmpDist, 'assets');
fs.mkdirSync(tmpAssetsDir, { recursive: true });
fs.writeFileSync(path.join(tmpDist, 'index.html'),
  '<!doctype html><html><body><div id="app"></div></body></html>');
fs.writeFileSync(path.join(tmpAssetsDir, 'foo.js'), 'console.log("test asset");');

// ── Totals fixtures (state dir + a session with a mapped and an unmapped worker) ──

const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-test-state-'));
const { estimateCost } = require('../bin/advisor-cost');

const totalsSid = 'totals-sid-0001';
const totalsSidDir = path.join(tmpHome, '.advisor', 'runs', totalsSid);
fs.mkdirSync(path.join(totalsSidDir, 'channel'), { recursive: true });
fs.writeFileSync(path.join(totalsSidDir, 'meta.json'),
  JSON.stringify({ agent: 'advisor', goal: 'totals test' }));
fs.writeFileSync(path.join(totalsSidDir, 'session.json'), JSON.stringify({
  sid: totalsSid,
  tier: 1,
  decomposition: [
    { sid: 'mapped-worker-sid', agent: 'coder', synthesis_seq: 1 },
    { sid: 'unmapped-worker-sid', agent: 'coder', synthesis_seq: 2 }
  ]
}));
fs.writeFileSync(path.join(totalsSidDir, 'channel', 'outbox.jsonl'),
  JSON.stringify({ type: 'progress', body: 'go', from: 'coder', seq: 1, ts: 1000 }) + '\n' +
  JSON.stringify({ type: 'result', body: { verdict: 'complete' }, from: 'coder', seq: 2, ts: 1012.5 }) + '\n'
);

fs.writeFileSync(path.join(tmpState, 'session-map.jsonl'),
  JSON.stringify({ run_sid: 'mapped-worker-sid', claude_uuid: 'mapped-claude-uuid', agent: 'coder' }) + '\n'
);
fs.writeFileSync(path.join(tmpState, 'token-usage.jsonl'),
  JSON.stringify({ sid: 'mapped-claude-uuid', input_tokens: 1000, output_tokens: 500, cache_read: 200, cache_creation: 50, total: 1750, ts: 1000 }) + '\n'
);

const expectedCost = estimateCost(1000, 500, 200, 50, null);

// ── Server lifecycle ──────────────────────────────────────────────────────────

let serverWithDist;
let serverNoDist;

before(async () => {
  [serverWithDist, serverNoDist] = await Promise.all([
    startServer({ HOME: tmpHome, ADVISOR_CLIENT_DIST: tmpDist, ADVISOR_STATE_DIR: tmpState }),
    startServer({ HOME: tmpHome, ADVISOR_CLIENT_DIST: '/nonexistent-dist-dir-xyz-abc' })
  ]);
});

after(() => {
  try { serverWithDist && serverWithDist.cleanup(); } catch (_) {}
  try { serverNoDist && serverNoDist.cleanup(); } catch (_) {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(tmpDist, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(tmpState, { recursive: true, force: true }); } catch (_) {}
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /api/sessions/:sid/workers returns {workers, totals} with correct shape', async () => {
  const r = await httpGet(serverWithDist.port, `/api/sessions/${totalsSid}/workers`);
  assert.strictEqual(r.status, 200, 'status 200');
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.workers), 'workers is an array');
  assert.ok('totals' in body, 'body has totals key');
  const t = body.totals;
  for (const key of ['input_tokens', 'output_tokens', 'cache_read', 'cache_creation', 'cost_usd', 'elapsed_ms', 'workers_counted', 'workers_missing']) {
    assert.ok(key in t, `totals has ${key}`);
  }
});

test('GET /api/sessions/:sid/workers totals sum only the mapped worker and count the unmapped one as missing', async () => {
  const r = await httpGet(serverWithDist.port, `/api/sessions/${totalsSid}/workers`);
  const t = JSON.parse(r.body).totals;
  assert.strictEqual(t.input_tokens, 1000, 'input_tokens from mapped worker only');
  assert.strictEqual(t.output_tokens, 500, 'output_tokens from mapped worker only');
  assert.strictEqual(t.cache_read, 200, 'cache_read from mapped worker only');
  assert.strictEqual(t.cache_creation, 50, 'cache_creation from mapped worker only');
  assert.ok(Math.abs(t.cost_usd - expectedCost) < 1e-9, `cost_usd matches estimateCost (got ${t.cost_usd}, expected ${expectedCost})`);
  assert.strictEqual(t.workers_counted, 1, 'one worker counted');
  assert.strictEqual(t.workers_missing, 1, 'one worker missing (no session-map entry)');
  assert.strictEqual(t.elapsed_ms, 12500, 'elapsed_ms from min/max message ts, in ms');
});

test('GET /api/sessions/:sid/workers totals for unknown sid: all workers missing, zero cost', async () => {
  const r = await httpGet(serverWithDist.port, '/api/sessions/no-such-sid-for-totals/workers');
  assert.strictEqual(r.status, 200, 'status 200');
  const t = JSON.parse(r.body).totals;
  assert.strictEqual(t.workers_counted, 0, 'no workers counted');
  assert.strictEqual(t.workers_missing, 1, 'the sid itself counts as the sole missing worker');
  assert.strictEqual(t.cost_usd, 0, 'zero cost when nothing found');
});

test('GET /api/sessions/:sid/detail returns meta, session, synthesisRecords', async () => {
  const r = await httpGet(serverWithDist.port, `/api/sessions/${fakeSid}/detail`);
  assert.strictEqual(r.status, 200, 'status 200');
  const body = JSON.parse(r.body);
  assert.ok('meta' in body, 'body has meta key');
  assert.ok('session' in body, 'body has session key');
  assert.ok('synthesisRecords' in body, 'body has synthesisRecords key');
  assert.strictEqual(body.meta.agent, 'test-worker', 'meta.agent correct');
  assert.strictEqual(body.session.sid, fakeSid, 'session.sid correct');
  assert.strictEqual(body.synthesisRecords.length, 2, 'two valid JSONL records, bad line skipped');
  assert.strictEqual(body.synthesisRecords[0].seq, 1);
  assert.strictEqual(body.synthesisRecords[1].seq, 2);
});

test('GET /api/sessions/:sid/detail returns 404 for missing sid', async () => {
  const r = await httpGet(serverWithDist.port, '/api/sessions/no-such-sid-xyz/detail');
  assert.strictEqual(r.status, 404, 'status 404');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not found', 'error field');
});

test('GET /assets/foo.js returns 200 with application/javascript content-type', async () => {
  const r = await httpGet(serverWithDist.port, '/assets/foo.js');
  assert.strictEqual(r.status, 200, 'status 200');
  assert.ok(r.headers['content-type'].includes('application/javascript'),
    `expected application/javascript, got: ${r.headers['content-type']}`);
  assert.ok(r.body.includes('test asset'), 'body contains file content');
});

test('GET /legacy returns old timeline HTML', async () => {
  const r = await httpGet(serverWithDist.port, '/legacy');
  assert.strictEqual(r.status, 200, 'status 200');
  assert.ok(r.body.startsWith('<!DOCTYPE'), 'starts with DOCTYPE');
  assert.ok(r.body.includes('Advisor Timeline'), 'contains Advisor Timeline title');
});

test('GET / with dist serves Svelte shell HTML', async () => {
  const r = await httpGet(serverWithDist.port, '/');
  assert.strictEqual(r.status, 200, 'status 200');
  assert.ok(r.body.includes('<div id="app">'), 'contains Svelte app div');
});

test('GET / without dist serves legacy timeline HTML', async () => {
  const r = await httpGet(serverNoDist.port, '/');
  assert.strictEqual(r.status, 200, 'status 200');
  assert.ok(r.body.startsWith('<!DOCTYPE'), 'starts with DOCTYPE when no dist');
  assert.ok(r.body.includes('Advisor Timeline'), 'contains Advisor Timeline when no dist');
});

test('GET /api/sessions no regression', async () => {
  const r = await httpGet(serverWithDist.port, '/api/sessions');
  assert.strictEqual(r.status, 200, 'status 200');
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body), 'returns an array');
});

test('GET /api/sessions excludes dirs with isTestSession:true in meta.json', async () => {
  const r = await httpGet(serverWithDist.port, '/api/sessions');
  assert.strictEqual(r.status, 200, 'status 200');
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body), 'returns an array');
  const sids = body.map(s => s.sid);
  assert.ok(sids.includes(fakeSid), 'normal session is present');
  assert.ok(!sids.includes(testSessionSid), 'isTestSession dir is excluded');
});
