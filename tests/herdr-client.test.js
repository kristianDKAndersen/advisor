import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { createClient, HerdrError, HerdrUnavailableError } from '../lib/herdr-client.js';
import { startFakeHerdr } from './fixtures/herdr-fake-server.js';

for (const k of ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_ENV', 'ADVISOR_HERDR']) delete process.env[k];

let fake;
const extra = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('until: timeout'); await sleep(10); } };

beforeEach(async () => {
  fake = await startFakeHerdr({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }, { pane_id: 'w1:p2', tab_id: 'w1:t1', tokens: { advisor_sid: 's1' } }] });
});
afterEach(async () => {
  for (const fn of extra.splice(0)) await fn();
  await fake.stop();
});

test('request resolves reply.result', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const r = await c.request('pane.get', { pane_id: 'w1:p2' });
  expect(r.type).toBe('pane_info');
  expect(r.pane.tokens.advisor_sid).toBe('s1');
  expect(fake.calls[0]).toEqual({ method: 'pane.get', params: { pane_id: 'w1:p2' } });
});

test('request without params sends an empty object', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const r = await c.request('pane.list');
  expect(r.panes.length).toBe(2);
  expect(fake.calls[0].params).toEqual({});
});

test('pane_not_found rejects HerdrError with code', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const err = await c.request('pane.get', { pane_id: 'w9:p9' }).catch((e) => e);
  expect(err).toBeInstanceOf(HerdrError);
  expect(err.code).toBe('pane_not_found');
  expect(err.message).toContain('w9:p9');
});

test('refused connect rejects HerdrUnavailableError with cause', async () => {
  const c = createClient({ socketPath: path.join(os.tmpdir(), 'hf-no-such.sock') });
  const err = await c.request('ping').catch((e) => e);
  expect(err).toBeInstanceOf(HerdrUnavailableError);
  expect(err.cause).toBeTruthy();
});

test('no reply within timeoutMs rejects HerdrUnavailableError', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'));
  const sp = path.join(dir, 'h.sock');
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(sp, r));
  extra.push(async () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const c = createClient({ socketPath: sp, timeoutMs: 50 });
  const t = Date.now();
  const err = await c.request('ping').catch((e) => e);
  expect(err).toBeInstanceOf(HerdrUnavailableError);
  expect(Date.now() - t).toBeLessThan(1000);
});

test('socket closed mid-request rejects HerdrUnavailableError', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'));
  const sp = path.join(dir, 'h.sock');
  const srv = net.createServer((s) => s.on('data', () => s.destroy()));
  await new Promise((r) => srv.listen(sp, r));
  extra.push(async () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const err = await createClient({ socketPath: sp }).request('ping').catch((e) => e);
  expect(err).toBeInstanceOf(HerdrUnavailableError);
});

test('a reply line split across two socket chunks parses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'));
  const sp = path.join(dir, 'h.sock');
  const srv = net.createServer((s) => s.on('data', async (d) => {
    const { id } = JSON.parse(String(d));
    const line = JSON.stringify({ id, result: { type: 'pong', version: 'x', protocol: 22 } }) + '\n';
    s.write(line.slice(0, 10));
    await sleep(30);
    s.write(line.slice(10));
  }));
  await new Promise((r) => srv.listen(sp, r));
  extra.push(async () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await createClient({ socketPath: sp }).request('ping');
  expect(r.type).toBe('pong');
});

test('subscribe delivers a normalised pane_exited event after the ack', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const events = [];
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent: (e) => events.push(e) });
  extra.push(() => sub.close());
  await sub.ready;
  expect(fake.calls.find((x) => x.method === 'events.subscribe').params).toEqual({ subscriptions: [{ type: 'pane.exited' }] });
  const c2 = createClient({ socketPath: fake.socketPath });
  await c2.request('pane.close', { pane_id: 'w1:p2' });
  await until(() => events.length === 1);
  expect(events[0].event).toBe('pane_exited');
  expect(events[0].paneId).toBe('w1:p2');
  expect(events[0].workspaceId).toBe('w1');
  expect(events[0].raw.data.type).toBe('pane_exited');
});

test('event name falls back to data.type when the envelope has no event field', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const events = [];
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent: (e) => events.push(e) });
  extra.push(() => sub.close());
  await sub.ready;
  fake.emit({ data: { pane_id: 'w1:p9', type: 'pane_exited', workspace_id: 'w1' } });
  await until(() => events.length === 1);
  expect(events[0].event).toBe('pane_exited');
  expect(events[0].paneId).toBe('w1:p9');
});

test('dropSubscribers triggers reconnect and onOpen fires again', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  let opens = 0;
  const events = [];
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent: (e) => events.push(e), onOpen: () => { opens++; } }, { backoffMs: [10] });
  extra.push(() => sub.close());
  await sub.ready;
  expect(opens).toBe(1);
  fake.dropSubscribers();
  await until(() => opens === 2);
  fake.emit({ data: { pane_id: 'w1:p1', type: 'pane_exited', workspace_id: 'w1' }, event: 'pane_exited' });
  await until(() => events.length === 1);
});

test('reconnect:false reports the drop once via onClose and does not reconnect', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const closes = [];
  let opens = 0;
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent() {}, onOpen: () => { opens++; }, onClose: (e) => closes.push(e) }, { reconnect: false });
  extra.push(() => sub.close());
  await sub.ready;
  fake.dropSubscribers();
  await until(() => closes.length === 1);
  await sleep(100);
  expect(opens).toBe(1);
  expect(closes.length).toBe(1);
});

test('after maxDowntimeMs with the server stopped onClose fires once with HerdrUnavailableError', async () => {
  const f2 = await startFakeHerdr({});
  const c = createClient({ socketPath: f2.socketPath, timeoutMs: 200 });
  const closes = [];
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent() {}, onClose: (e) => closes.push(e) }, { backoffMs: [10], maxDowntimeMs: 100 });
  await sub.ready;
  await f2.stop();
  await until(() => closes.length === 1);
  await sleep(150);
  expect(closes.length).toBe(1);
  expect(closes[0]).toBeInstanceOf(HerdrUnavailableError);
});

test('subscribe against an unreachable socket rejects ready after maxDowntimeMs', async () => {
  const c = createClient({ socketPath: path.join(os.tmpdir(), 'hf-no-such.sock') });
  const closes = [];
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent() {}, onClose: (e) => closes.push(e) }, { backoffMs: [10], maxDowntimeMs: 60 });
  const err = await sub.ready.catch((e) => e);
  expect(err).toBeInstanceOf(HerdrUnavailableError);
  expect(closes.length).toBe(1);
});

test('close() stops delivery and reconnects without firing onClose', async () => {
  const c = createClient({ socketPath: fake.socketPath });
  const closes = [];
  let opens = 0;
  const sub = c.subscribe([{ type: 'pane.exited' }], { onEvent() {}, onOpen: () => { opens++; }, onClose: (e) => closes.push(e) }, { backoffMs: [10] });
  await sub.ready;
  sub.close();
  fake.dropSubscribers();
  await sleep(100);
  expect(opens).toBe(1);
  expect(closes.length).toBe(0);
});

test('fake server throws on tab.close, workspace.close, server.stop and session.stop', async () => {
  for (const method of ['tab.close', 'workspace.close', 'server.stop', 'session.stop']) {
    const f = await startFakeHerdr({});
    const errors = [];
    const handler = (e) => errors.push(e);
    process.on('uncaughtException', handler);
    await new Promise((res) => {
      const raw = net.connect(f.socketPath, () => raw.write(JSON.stringify({ id: 'x', method, params: {} }) + '\n'));
      setTimeout(() => { raw.destroy(); res(); }, 100);
      raw.on('error', () => res());
      raw.on('close', () => res());
    });
    await sleep(20);
    process.off('uncaughtException', handler);
    await expect(f.stop()).rejects.toThrow(method);
    expect(f.calls.map((c) => c.method)).toContain(method);
  }
});

test('lib/herdr-client.js never names a destructive method', () => {
  const src = fs.readFileSync(new URL('../lib/herdr-client.js', import.meta.url), 'utf8');
  for (const m of ['tab.close', 'workspace.close', 'server.stop', 'session.stop']) expect(src.includes(m)).toBe(false);
});

test('request rejects methods outside the allow-list without touching the socket', async () => {
  let connects = 0;
  const c = createClient({ socketPath: fake.socketPath, connect: (p) => { connects += 1; return net.connect(p); } });
  for (const m of ['tab.close', 'workspace.close', 'server.stop', 'session.stop', 'pane.delete', 'agent.kill', '']) {
    const err = await c.request(m, {}).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe('method_not_allowed');
  }
  expect(connects).toBe(0);
  expect(fake.calls.length).toBe(0);
});

test('every allow-listed method is sent to the socket', async () => {
  const allowed = ['pane.get', 'pane.list', 'tab.list', 'tab.create', 'pane.split', 'pane.close', 'pane.report_metadata', 'pane.read', 'pane.send_text', 'pane.send_keys', 'workspace.list', 'ping', 'agent.get', 'agent.prompt'];
  const c = createClient({ socketPath: fake.socketPath, timeoutMs: 200 });
  for (const m of allowed) {
    const err = await c.request(m, {}).catch((e) => e);
    expect(err && err.code).not.toBe('method_not_allowed');
  }
  expect(fake.calls.map((x) => x.method)).toEqual(allowed);
});

test('the preload scrubs ADVISOR_WORKER_BACKEND and HERDR_BIN_PATH', () => {
  expect(process.env.ADVISOR_WORKER_BACKEND).toBeUndefined();
  expect(process.env.HERDR_BIN_PATH).toBeUndefined();
});
