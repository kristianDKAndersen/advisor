import { test, expect } from 'bun:test';

// Tests for the enabledMcpjsonServers key written to workspace .claude/settings.json.
// We test the pure buildMcpSettings helper, which isolates the MCP-approval logic
// so it can be verified without provisioning a full session.

const { buildMcpSettings } = await import('../lib/summon.js');

test('buildMcpSettings returns an object with enabledMcpjsonServers', () => {
  const result = buildMcpSettings();
  expect(result).toHaveProperty('enabledMcpjsonServers');
});

test('buildMcpSettings enabledMcpjsonServers is an empty array', () => {
  const result = buildMcpSettings();
  expect(Array.isArray(result.enabledMcpjsonServers)).toBe(true);
  expect(result.enabledMcpjsonServers).toHaveLength(0);
});

test('buildMcpSettings returns a fresh array on each call (not a shared reference)', () => {
  const a = buildMcpSettings();
  const b = buildMcpSettings();
  expect(a.enabledMcpjsonServers).not.toBe(b.enabledMcpjsonServers);
});
