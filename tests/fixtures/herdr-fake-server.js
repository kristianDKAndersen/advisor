// Fake herdr unix-socket server. Shapes copy the live probe log and schema.json (see shapes.md).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FORBIDDEN = new Set(['tab.close', 'workspace.close', 'server.stop', 'session.stop']);

export async function startFakeHerdr({ panes = [], tabs = [], workspaceId = 'w1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'));
  const socketPath = path.join(dir, 'h.sock');
  const calls = [];
  const violations = [];
  const sockets = new Set();
  const subscribers = new Set();
  const paneMap = new Map();
  const tabList = tabs.map((t) => ({ workspace_id: workspaceId, focused: false, agent_status: 'unknown', pane_count: 0, ...t }));
  let paneSeq = 0;
  let tabSeq = tabList.length;

  const mkPane = (p) => ({
    agent_status: 'unknown', cwd: null, focused: false, foreground_cwd: null, revision: 0,
    workspace_id: workspaceId, terminal_id: `term_${++paneSeq}`, ...p,
  });
  for (const p of panes) paneMap.set(p.pane_id, mkPane(p));
  const publicPane = (p) => ({ ...p });
  const countPanes = (tabId) => [...paneMap.values()].filter((p) => p.tab_id === tabId).length;
  const tabInfo = (t) => ({ ...t, pane_count: countPanes(t.tab_id) });

  const send = (sock, obj) => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
  const notFound = (id) => ({ error: { code: 'pane_not_found', message: `pane ${id} not found` } });

  function emit(evt) {
    const line = evt.event || !evt.data ? evt : { ...evt, event: evt.data.type };
    for (const s of subscribers) send(s, line);
  }
  function exitPane(p) {
    paneMap.delete(p.pane_id);
    emit({ data: { pane_id: p.pane_id, type: 'pane_exited', workspace_id: p.workspace_id }, event: 'pane_exited' });
  }

  function handle(sock, req) {
    const { method, params = {} } = req;
    switch (method) {
      case 'ping': return { result: { type: 'pong', version: '0.9.5', protocol: 22 } };
      case 'workspace.list':
        return { result: { type: 'workspace_list', workspaces: [{ workspace_id: workspaceId, label: 'ws', number: 1, focused: true, agent_status: 'unknown', pane_count: paneMap.size, tab_count: tabList.length }] } };
      case 'tab.list': return { result: { type: 'tab_list', tabs: tabList.map(tabInfo) } };
      case 'tab.create': {
        const tab = { tab_id: `${workspaceId}:t${++tabSeq}`, workspace_id: params.workspace_id || workspaceId, label: params.label ?? String(tabSeq), number: tabSeq, focused: !!params.focus, agent_status: 'unknown', pane_count: 1 };
        tabList.push(tab);
        const root = mkPane({ pane_id: `${workspaceId}:p${paneMap.size + 1 + tabSeq * 100}`, tab_id: tab.tab_id, cwd: params.cwd ?? null });
        paneMap.set(root.pane_id, root);
        return { result: { type: 'tab_created', tab: tabInfo(tab), root_pane: publicPane(root) } };
      }
      case 'pane.list': return { result: { type: 'pane_list', panes: [...paneMap.values()].map(publicPane) } };
      case 'pane.get': {
        const p = paneMap.get(params.pane_id);
        return p ? { result: { type: 'pane_info', pane: publicPane(p) } } : notFound(params.pane_id);
      }
      case 'pane.split': {
        const target = paneMap.get(params.target_pane_id);
        if (!target) return notFound(params.target_pane_id);
        const p = mkPane({ pane_id: `${workspaceId}:p${paneMap.size + 1 + paneSeq * 100}`, tab_id: target.tab_id, cwd: params.cwd ?? null });
        paneMap.set(p.pane_id, p);
        return { result: { type: 'pane_info', pane: publicPane(p) } };
      }
      case 'pane.close': {
        const p = paneMap.get(params.pane_id);
        if (!p) return notFound(params.pane_id);
        exitPane(p);
        return { result: { type: 'ok' } };
      }
      case 'pane.report_metadata': {
        const p = paneMap.get(params.pane_id);
        if (!p) return notFound(params.pane_id);
        const tokens = { ...(p.tokens || {}) };
        for (const [k, v] of Object.entries(params.tokens || {})) {
          if (v === null) delete tokens[k]; else tokens[k] = String(v).slice(0, 80);
        }
        p.tokens = tokens;
        p.revision += 1;
        return { result: { type: 'ok' } };
      }
      case 'pane.send_text':
      case 'pane.send_keys':
        return paneMap.has(params.pane_id) ? { result: { type: 'ok' } } : notFound(params.pane_id);
      case 'pane.read': {
        const p = paneMap.get(params.pane_id);
        if (!p) return notFound(params.pane_id);
        return { result: { type: 'pane_read', read: { format: params.format || 'text', pane_id: p.pane_id, revision: 0, source: params.source, tab_id: p.tab_id, text: p.text || '', truncated: false, workspace_id: p.workspace_id } } };
      }
      case 'events.subscribe':
        subscribers.add(sock);
        return { result: { type: 'subscription_started' } };
      default:
        return { error: { code: 'unknown_method', message: `unknown method ${method}` } };
    }
  }

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('close', () => { sockets.delete(sock); subscribers.delete(sock); });
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        calls.push({ method: req.method, params: req.params });
        if (FORBIDDEN.has(req.method)) {
          violations.push(req.method);
          throw new Error(`herdr-fake-server: forbidden method ${req.method}`);
        }
        send(sock, { id: req.id, ...handle(sock, req) });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });

  return {
    socketPath,
    calls,
    emit,
    dropSubscribers() { for (const s of [...subscribers]) s.destroy(); subscribers.clear(); },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
      if (violations.length) throw new Error(`herdr-fake-server: forbidden methods received: ${violations.join(',')}`);
    },
  };
}
