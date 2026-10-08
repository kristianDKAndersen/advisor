import { test, expect, afterAll } from 'bun:test';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const _require = createRequire(import.meta.url);
const { buildPluginOverrides } = _require('../lib/summon.js');
const agents = _require('../lib/agents.js');

// Tests for shrinking the worker's fixed prefix by disabling user-level
// Claude Code plugins (which re-inject their skills into every worker turn)
// unless the agent explicitly allowlists one via `plugins:` frontmatter.

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const TS = Date.now();

const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-plugins-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-plugins-home-'));

const AGENT_NAME = `test-plugins-${TS}`;
const agentDir = path.join(ADVISOR_ROOT, 'spawns', AGENT_NAME);

const spawnsDir = path.join(ADVISOR_ROOT, 'spawns');
for (const entry of fs.readdirSync(spawnsDir)) {
  // Only stale dirs: a concurrent suite run in this checkout owns fresh ones.
  const ts = Number(entry.slice('test-plugins-'.length));
  if (entry.startsWith('test-plugins-') && !(TS - ts < 600000)) {
    fs.rmSync(path.join(spawnsDir, entry), { recursive: true, force: true });
  }
}

function doCleanup() {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
}
afterAll(doCleanup);

try {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'CLAUDE.md'),
    '---\nname: ' + AGENT_NAME + '\ndescription: test agent\nplugins: [chrome-devtools-mcp@claude-plugins-official]\n---\n\n' +
    '# Test agent for plugin-disable\n\nSynthetic fixture — auto-deleted after tests.\n'
  );
  fs.mkdirSync(path.join(HOME_TMP, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME_TMP, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        'figma@claude-plugins-official': true,
        'vercel@claude-plugins-official': true,
        'chrome-devtools-mcp@claude-plugins-official': true,
        'disabled-already@foo': false
      }
    })
  );
} catch (e) {
  doCleanup();
  throw e;
}

function provision(extraEnv, homeDir) {
  const sid = `test-plugins-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const result = spawnSync(
    'node',
    [SUMMON_JS, '--agent', AGENT_NAME, '--task', 'plugin-disable test — ignore', '--goal', 'test', '--sid', sid],
    {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: homeDir || HOME_TMP, ...extraEnv }
    }
  );
  if (result.status !== 0) {
    throw new Error(`summon exited ${result.status}: ${result.stderr}`);
  }
  const meta = JSON.parse(result.stdout.trim());
  const settingsPath = path.join(meta.workspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { meta, settings };
}

let sessionDefault, sessionKeep, sessionNoUserSettings, sessionMalformedUserSettings;

try {
  sessionDefault = provision({ ADVISOR_KEEP_PLUGINS: '' });
} catch (e) { doCleanup(); throw e; }

try {
  sessionKeep = provision({ ADVISOR_KEEP_PLUGINS: '1' });
} catch (e) { doCleanup(); throw e; }

{
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-plugins-home-empty-'));
  try {
    sessionNoUserSettings = provision({ ADVISOR_KEEP_PLUGINS: '' }, emptyHome);
  } catch (e) {
    fs.rmSync(emptyHome, { recursive: true, force: true });
    doCleanup();
    throw e;
  }
  fs.rmSync(emptyHome, { recursive: true, force: true });
}

{
  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-plugins-home-bad-'));
  fs.mkdirSync(path.join(badHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(badHome, '.claude', 'settings.json'), 'not valid json {{');
  try {
    sessionMalformedUserSettings = provision({ ADVISOR_KEEP_PLUGINS: '' }, badHome);
  } catch (e) {
    fs.rmSync(badHome, { recursive: true, force: true });
    doCleanup();
    throw e;
  }
  fs.rmSync(badHome, { recursive: true, force: true });
}

test('default: all enabled user plugins are disabled except allowlisted', () => {
  const ep = sessionDefault.settings.enabledPlugins;
  expect(ep['figma@claude-plugins-official']).toBe(false);
  expect(ep['vercel@claude-plugins-official']).toBe(false);
});

test('default: allowlisted plugin is left enabled (not forced false)', () => {
  const ep = sessionDefault.settings.enabledPlugins;
  expect(ep['chrome-devtools-mcp@claude-plugins-official']).not.toBe(false);
});

test('default: already-disabled plugin is left alone', () => {
  const ep = sessionDefault.settings.enabledPlugins;
  expect(ep['disabled-already@foo']).not.toBe(true);
});

test('ADVISOR_KEEP_PLUGINS=1 leaves enabledPlugins untouched', () => {
  expect(sessionKeep.settings.enabledPlugins).toBeUndefined();
});

test('missing user settings.json is a no-op, not a crash', () => {
  expect(sessionNoUserSettings.settings.enabledPlugins).toBeUndefined();
});

test('malformed user settings.json is a no-op, not a crash', () => {
  expect(sessionMalformedUserSettings.settings.enabledPlugins).toBeUndefined();
});

test('buildPluginOverrides disables all enabled plugins when allowlist empty', () => {
  const result = buildPluginOverrides({ enabledPlugins: { a: true, b: true } }, []);
  expect(result).toEqual({ a: false, b: false });
});

test('buildPluginOverrides keeps allowlisted ids out of the override (never forces true)', () => {
  const result = buildPluginOverrides({ enabledPlugins: { a: true, b: true } }, ['a']);
  expect(result).toEqual({ b: false });
});

test('buildPluginOverrides ignores already-false plugins', () => {
  const result = buildPluginOverrides({ enabledPlugins: { a: false } }, []);
  expect(result).toEqual({});
});

test('buildPluginOverrides returns {} for missing/malformed input', () => {
  expect(buildPluginOverrides(null, [])).toEqual({});
  expect(buildPluginOverrides({}, [])).toEqual({});
  expect(buildPluginOverrides({ enabledPlugins: 'bad' }, [])).toEqual({});
  expect(buildPluginOverrides(undefined, undefined)).toEqual({});
});

test('spawns/browser and spawns/frontend frontmatter still parses allowed-tools after plugins field added', () => {
  const browserFm = agents.parseFrontmatter(path.join(ADVISOR_ROOT, 'spawns', 'browser', 'CLAUDE.md'));
  const frontendFm = agents.parseFrontmatter(path.join(ADVISOR_ROOT, 'spawns', 'frontend', 'CLAUDE.md'));
  expect(browserFm['allowed-tools']).toBeTruthy();
  expect(frontendFm['allowed-tools']).toBeTruthy();
  expect(String(browserFm.plugins)).toContain('chrome-devtools-mcp@claude-plugins-official');
  expect(String(frontendFm.plugins)).toContain('chrome-devtools-mcp@claude-plugins-official');
});
