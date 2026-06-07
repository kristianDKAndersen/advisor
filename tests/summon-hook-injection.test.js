import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');

// U14: provisionOne must write workspace .claude/settings.json with
// hooks.PreToolUse and hooks.PreCompact entries after the skill-symlink step.
// Currently no hooks key is written.

let provisionedWorkspace = null;
let provisionedSid = null;

const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'summon-hook-injection-'));

// Provision a real (non-coder) workspace by calling lib/summon.js directly.
// We use agent=researcher which only copies a small directory — no git worktree.
const sid = `test-hook-injection-${Date.now()}`;
const result = spawnSync(
  'node',
  [
    SUMMON_JS,
    '--agent', 'researcher',
    '--task', 'hook injection test — ignore',
    '--goal', 'test',
    '--sid', sid,
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns },
  }
);

if (result.status === 0 && result.stdout.trim()) {
  try {
    const meta = JSON.parse(result.stdout.trim());
    provisionedWorkspace = meta.workspace;
    provisionedSid = meta.sid;
  } catch (_) {}
}

afterAll(() => {
  fs.rmSync(tmpRuns, { recursive: true, force: true });
});

test('provisionOne exits 0 and returns workspace path', () => {
  expect(result.status).toBe(0);
  expect(provisionedWorkspace).not.toBeNull();
  expect(typeof provisionedWorkspace).toBe('string');
});

test('provisionOne writes .claude/settings.json in the workspace', () => {
  const settingsPath = path.join(provisionedWorkspace, '.claude', 'settings.json');
  expect(fs.existsSync(settingsPath)).toBe(true);
});

test('workspace .claude/settings.json contains hooks key', () => {
  const settingsPath = path.join(provisionedWorkspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Currently provisionOne does NOT write hooks → this assertion fails (RED).
  expect(settings).toHaveProperty('hooks');
});

test('workspace .claude/settings.json hooks contains PreToolUse entry', () => {
  const settingsPath = path.join(provisionedWorkspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.hooks).toHaveProperty('PreToolUse');
});

test('workspace .claude/settings.json hooks contains PreCompact entry', () => {
  const settingsPath = path.join(provisionedWorkspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.hooks).toHaveProperty('PreCompact');
});

// Schema correctness: each PreToolUse / PreCompact entry must follow
// {matcher, hooks:[{type:"command", command:"..."}]} or Claude Code rejects it.
test('PreToolUse entries match Claude Code schema (matcher + hooks array of {type,command})', () => {
  const settingsPath = path.join(provisionedWorkspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const entry of settings.hooks.PreToolUse) {
    expect(entry).toHaveProperty('hooks');
    expect(Array.isArray(entry.hooks)).toBe(true);
    for (const h of entry.hooks) {
      expect(h.type).toBe('command');
      expect(typeof h.command).toBe('string');
    }
  }
});

test('PreCompact entries match Claude Code schema (hooks array of {type,command})', () => {
  const settingsPath = path.join(provisionedWorkspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const entry of settings.hooks.PreCompact) {
    expect(entry).toHaveProperty('hooks');
    expect(Array.isArray(entry.hooks)).toBe(true);
    for (const h of entry.hooks) {
      expect(h.type).toBe('command');
      expect(typeof h.command).toBe('string');
    }
  }
});
