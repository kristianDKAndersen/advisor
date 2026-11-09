// JSON-lines transport for the herdr unix socket: {id,method,params}\n -> {id,result|error}\n.
'use strict';

const net = require('node:net');

class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

class HerdrUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HerdrUnavailableError';
    this.cause = cause;
  }
}

function toHerdrError(e) {
  return new HerdrError(e && e.code ? e.code : 'unknown', (e && e.message) || 'herdr error');
}

function normalise(raw) {
  const data = raw && typeof raw.data === 'object' && raw.data ? raw.data : {};
  const evt = { event: raw.event || data.type, raw };
  const paneId = data.pane_id || (data.pane && data.pane.pane_id);
  const workspaceId = data.workspace_id || (data.pane && data.pane.workspace_id);
  if (paneId) evt.paneId = paneId;
  if (workspaceId) evt.workspaceId = workspaceId;
  return evt;
}

// Calls onLine(parsed) per complete line; returns a feed(chunk) function. Unparseable lines are skipped.
function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      onLine(msg);
    }
  };
}

function createClient({ socketPath, timeoutMs = 10000, connect = net.connect } = {}) {
  let seq = 0;

  function open() {
    const sock = connect(socketPath);
    sock.setEncoding('utf8');
    return sock;
  }

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = `r${++seq}`;
      let settled = false;
      let sock;
      let timer;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock && sock.destroy(); } catch (_) {}
        fn(v);
      };
      try { sock = open(); } catch (e) { return reject(new HerdrUnavailableError(`herdr connect failed: ${e.message}`, e)); }
      timer = setTimeout(() => finish(reject, new HerdrUnavailableError(`herdr ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      const feed = lineReader((msg) => {
        if (msg.id !== undefined && msg.id !== id) return;
        if (msg.error) finish(reject, toHerdrError(msg.error));
        else if ('result' in msg) finish(resolve, msg.result);
      });
      sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
      sock.on('data', feed);
      sock.on('error', (e) => finish(reject, new HerdrUnavailableError(`herdr socket error: ${e.message}`, e)));
      sock.on('close', () => finish(reject, new HerdrUnavailableError(`herdr socket closed before ${method} replied`)));
    });
  }

  function subscribe(subscriptions, handlers, opts = {}) {
    const { reconnect = true, backoffMs = [500, 1000, 2000, 5000], maxDowntimeMs = 60000 } = opts;
    const { onEvent, onOpen, onClose } = handlers;
    let closed = false;
    let sock = null;
    let timer = null;
    let attempt = 0;
    let downSince = null;
    let acked = false;
    let readySettled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    ready.catch(() => {});
    const settleReady = (fn, v) => { if (!readySettled) { readySettled = true; fn(v); } };

    function giveUp(err) {
      if (closed) return;
      closed = true;
      settleReady(rejectReady, err);
      if (onClose) onClose(err);
    }

    function lost(err) {
      if (closed) return;
      sock = null;
      if (downSince === null) downSince = Date.now();
      if (!reconnect) return giveUp(err);
      if (Date.now() - downSince >= maxDowntimeMs) {
        return giveUp(new HerdrUnavailableError(`herdr subscriber down for ${Date.now() - downSince}ms`, err));
      }
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 500;
      attempt += 1;
      timer = setTimeout(start, delay);
    }

    function start() {
      timer = null;
      if (closed) return;
      acked = false;
      let s;
      try { s = open(); } catch (e) { return lost(new HerdrUnavailableError(`herdr connect failed: ${e.message}`, e)); }
      sock = s;
      let ended = false;
      const end = (err) => { if (ended) return; ended = true; try { s.destroy(); } catch (_) {} if (sock === s || sock === null) lost(err); };
      const feed = lineReader((msg) => {
        if (msg.error && !acked) {
          closed = true;
          try { s.destroy(); } catch (_) {}
          const e = toHerdrError(msg.error);
          settleReady(rejectReady, e);
          if (onClose) onClose(e);
          return;
        }
        if (msg.result && msg.result.type === 'subscription_started' && !acked) {
          acked = true;
          attempt = 0;
          downSince = null;
          settleReady(resolveReady);
          if (onOpen) onOpen();
          return;
        }
        if (acked && (msg.event || msg.data)) onEvent(normalise(msg));
      });
      s.on('connect', () => s.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } }) + '\n'));
      s.on('data', feed);
      s.on('error', (e) => end(new HerdrUnavailableError(`herdr socket error: ${e.message}`, e)));
      s.on('close', () => end(new HerdrUnavailableError('herdr subscription socket closed')));
    }

    start();
    return {
      ready,
      close() {
        closed = true;
        clearTimeout(timer);
        try { sock && sock.destroy(); } catch (_) {}
        settleReady(rejectReady, new HerdrUnavailableError('subscription closed'));
      },
    };
  }

  return { request, subscribe };
}

module.exports = { HerdrError, HerdrUnavailableError, createClient };
