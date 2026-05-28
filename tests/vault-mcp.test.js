import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

let tmpVaultRoot;
let vault;

const MCP_BIN = path.resolve(import.meta.dirname, '../bin/advisor-vault-mcp');

function mcpCall(input) {
  const result = spawnSync('bun', [MCP_BIN], {
    input: JSON.stringify(input) + '\n',
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: tmpVaultRoot },
    timeout: 10000
  });
  if (!result.stdout.trim()) {
    throw new Error(`No stdout. stderr=${result.stderr} status=${result.status}`);
  }
  return JSON.parse(result.stdout.trim().split('\n')[0]);
}

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');

  vault.writeNote('notes/alpha.md', { type: 'note', created_at: new Date().toISOString() }, 'Alpha content about integration testing.');
  vault.writeNote('notes/beta.md', { type: 'note', created_at: new Date().toISOString() }, 'Beta links to [[alpha]].');
  vault.writeNote('notes/gamma.md', { type: 'note', created_at: new Date().toISOString() }, 'Gamma also links [[alpha]] and to [[delta]].');

  // seed a blocked synthesis note for gaps tool
  vault.writeSynthesisNote({
    sid: 'MCP-BLOCKED-SID', seq: 1, ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'MCP gaps test', gap: 'none',
    material: 'yes', next_action: 'spawn-refinement: none',
    key_quotes: '', agent: 'mcp-test'
  });
  vault.setWorkerVerdict('synthesis/MCP-BLOCKED-SID-1.md', 'blocked');
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
});

test('T2b MCP initialize handshake returns serverInfo', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
  expect(resp.result.serverInfo.name).toBe('advisor-vault-mcp');
  expect(resp.result.protocolVersion).toBeDefined();
});

test('T2b MCP tools/list returns 8 tools', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  expect(resp.result.tools.length).toBe(8);
  const names = resp.result.tools.map(t => t.name);
  expect(names).toContain('search');
  expect(names).toContain('backlinks');
  expect(names).toContain('neighbors');
  expect(names).toContain('shortest_path');
  expect(names).toContain('hubs');
  expect(names).toContain('gaps');
  expect(names).toContain('due');
  expect(names).toContain('communities');
});

test('T2b MCP search tool returns FTS results', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { text: 'integration testing', limit: 5 } } });
  expect(resp.result).toBeDefined();
  const results = JSON.parse(resp.result.content[0].text);
  expect(results.length).toBeGreaterThan(0);
});

test('T2b MCP backlinks tool returns sources', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'backlinks', arguments: { note: 'alpha' } } });
  const results = JSON.parse(resp.result.content[0].text);
  expect(results.length).toBeGreaterThan(0);
  expect(results.some(r => r.includes('beta'))).toBe(true);
});

test('T2b MCP neighbors tool returns adjacent notes with kind/confidence', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'neighbors', arguments: { note: 'notes/beta.md' } } });
  const results = JSON.parse(resp.result.content[0].text);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].kind).toBe('wikilink');
  expect(results[0].confidence).toBe('EXTRACTED');
});

test('T2b MCP shortest_path tool returns path array via recursive CTE', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'shortest_path', arguments: { from: 'notes/beta.md', to: 'alpha' } } });
  const results = JSON.parse(resp.result.content[0].text);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]).toBe('notes/beta.md');
  expect(results[results.length - 1]).toBe('alpha');
});

test('T2b MCP hubs tool returns degree-ranked nodes', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hubs', arguments: { limit: 5 } } });
  const results = JSON.parse(resp.result.content[0].text);
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].deg).toBeDefined();
  expect(results[0].target).toBeDefined();
});

test('T2b MCP gaps tool returns blocked-without-lesson rows', () => {
  const resp = mcpCall({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'gaps', arguments: { limit: 10 } } });
  const results = JSON.parse(resp.result.content[0].text);
  expect(Array.isArray(results)).toBe(true);
  expect(results.some(r => r.sid === 'MCP-BLOCKED-SID')).toBe(true);
});
