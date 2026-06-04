import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Tests for MCP modal suppression in generated launch.sh.
// Strategy: --strict-mcp-config on the claude invocation means zero MCP servers
// from any config, so .mcp.json in the worker workspace never triggers the
// interactive "N new MCP servers found" prompt.

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const TS = Date.now();

const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-mcp-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-mcp-home-'));

const AGENT_NAME = `test-mcp-${TS}`;
const agentDir = path.join(ADVISOR_ROOT, 'spawns', AGENT_NAME);

// Clean up leftover test-mcp-* dirs from previous failed runs.
const spawnsDir = path.join(ADVISOR_ROOT, 'spawns');
for (const entry of fs.readdirSync(spawnsDir)) {
  if (entry.startsWith('test-mcp-')) {
    fs.rmSync(path.join(spawnsDir, entry), { recursive: true, force: true });
  }
}

function doCleanup() {
  fs.rmSync(agentDir,  { recursive: true, force: true });
  fs.rmSync(RUNS_TMP,  { recursive: true, force: true });
  fs.rmSync(HOME_TMP,  { recursive: true, force: true });
}

afterAll(doCleanup);

try {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'CLAUDE.md'),
    '# Test agent for MCP settings\n\nSynthetic fixture — auto-deleted after tests.\n'
  );
} catch (e) {
  doCleanup();
  throw e;
}

function provision() {
  const sid = `test-mcp-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const result = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', AGENT_NAME,
      '--task',  'mcp-settings test — ignore',
      '--goal',  'test',
      '--sid',   sid,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
    }
  );
  if (result.status !== 0) {
    throw new Error(`summon exited ${result.status}: ${result.stderr}`);
  }
  const meta = JSON.parse(result.stdout.trim());
  const launchSh = fs.readFileSync(meta.launchScript, 'utf8');
  const settingsPath = path.join(meta.workspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { meta, launchSh, settings };
}

let session;
try {
  session = provision();
} catch (e) {
  doCleanup();
  throw e;
}

test('summon exits 0 and generates a launch.sh', () => {
  expect(session).not.toBeNull();
  expect(typeof session.launchSh).toBe('string');
});

test('launch.sh contains --strict-mcp-config', () => {
  expect(session.launchSh).toContain('--strict-mcp-config');
});

test('launch.sh has --strict-mcp-config before the -- terminator', () => {
  const sh = session.launchSh;
  const strictIdx = sh.indexOf('--strict-mcp-config');
  const terminatorIdx = sh.indexOf(' -- ');
  expect(strictIdx).toBeGreaterThan(-1);
  expect(terminatorIdx).toBeGreaterThan(-1);
  expect(strictIdx).toBeLessThan(terminatorIdx);
});

test('workspace settings.json does not contain enabledMcpjsonServers', () => {
  expect(Object.keys(session.settings)).not.toContain('enabledMcpjsonServers');
});

test('launch.sh does not contain enabledMcpjsonServers', () => {
  expect(session.launchSh).not.toContain('enabledMcpjsonServers');
});
