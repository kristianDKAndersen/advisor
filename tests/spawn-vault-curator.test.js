import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADVISOR_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const agents = require('../lib/agents');

const claudeMdPath = path.join(ADVISOR_ROOT, 'spawns', 'vault-curator', 'CLAUDE.md');
const settingsPath = path.join(ADVISOR_ROOT, 'spawns', 'vault-curator', '.claude', 'settings.json');

// (a) CLAUDE.md exists and parses (frontmatter + body)
test('spawns/vault-curator/CLAUDE.md exists', () => {
  expect(fs.existsSync(claudeMdPath)).toBe(true);
});

test('spawns/vault-curator/CLAUDE.md has non-empty body', () => {
  const content = fs.readFileSync(claudeMdPath, 'utf8');
  expect(content.length).toBeGreaterThan(0);
  // Has frontmatter delimiters
  expect(content).toMatch(/^---/);
});

// (b) frontmatter contains: role, inputs, tools, default_tools
test('spawns/vault-curator frontmatter has role', () => {
  const fm = agents.parseFrontmatter(claudeMdPath);
  expect(fm.role).toBe('vault-curator');
});

test('spawns/vault-curator frontmatter has inputs array', () => {
  const fm = agents.parseFrontmatter(claudeMdPath);
  expect(Array.isArray(fm.inputs)).toBe(true);
  expect(fm.inputs.length).toBeGreaterThan(0);
});

test('spawns/vault-curator frontmatter has tools array', () => {
  const fm = agents.parseFrontmatter(claudeMdPath);
  expect(Array.isArray(fm.tools)).toBe(true);
  expect(fm.tools.length).toBeGreaterThan(0);
});

test('spawns/vault-curator frontmatter has default_tools array', () => {
  const fm = agents.parseFrontmatter(claudeMdPath);
  expect(Array.isArray(fm.default_tools)).toBe(true);
  expect(fm.default_tools.length).toBeGreaterThan(0);
});

// (c) lib/agents.js listAgentsWithMeta() includes name='vault-curator'
test('listAgentsWithMeta includes vault-curator', () => {
  const list = agents.listAgentsWithMeta();
  const entry = list.find(a => a.name === 'vault-curator');
  expect(entry).toBeDefined();
  expect(entry.role).toBe('vault-curator');
});

// (d) settings.json has permissions.allow array and does NOT include Write or Edit
test('spawns/vault-curator/.claude/settings.json exists', () => {
  expect(fs.existsSync(settingsPath)).toBe(true);
});

test('spawns/vault-curator settings.json has permissions.allow array', () => {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(Array.isArray(settings.permissions?.allow)).toBe(true);
  expect(settings.permissions.allow.length).toBeGreaterThan(0);
});

test('spawns/vault-curator settings.json permissions.allow does NOT include Write', () => {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const allow = settings.permissions.allow;
  // None of the allow entries should be exactly 'Write' or start with 'Write'
  const writeLike = allow.filter(e => e === 'Write' || e.startsWith('Write('));
  expect(writeLike.length).toBe(0);
});

test('spawns/vault-curator settings.json permissions.allow does NOT include Edit', () => {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const allow = settings.permissions.allow;
  const editLike = allow.filter(e => e === 'Edit' || e.startsWith('Edit('));
  expect(editLike.length).toBe(0);
});
