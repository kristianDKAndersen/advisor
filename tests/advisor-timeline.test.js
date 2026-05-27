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

// ── Server lifecycle ──────────────────────────────────────────────────────────

let serverWithDist;
let serverNoDist;

before(async () => {
  [serverWithDist, serverNoDist] = await Promise.all([
    startServer({ HOME: tmpHome, ADVISOR_CLIENT_DIST: tmpDist }),
    startServer({ HOME: tmpHome, ADVISOR_CLIENT_DIST: '/nonexistent-dist-dir-xyz-abc' })
  ]);
});

after(() => {
  try { serverWithDist && serverWithDist.cleanup(); } catch (_) {}
  try { serverNoDist && serverNoDist.cleanup(); } catch (_) {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(tmpDist, { recursive: true, force: true }); } catch (_) {}
});

// ── Tests ─────────────────────────────────────────────────────────────────────

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
