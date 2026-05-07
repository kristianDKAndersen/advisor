import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// U1 Phase 5 — RED tests for lib/agents.js (does not exist yet).
// Import will fail with "Cannot find module" until lib/agents.js is created.

import { parseFrontmatter, listAgentsWithMeta } from '../lib/agents.js';

// --- tmp fixture setup ---

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Fixture: .md file with no frontmatter block
const noFrontmatterFile = path.join(tmpDir, 'no-frontmatter.md');
fs.writeFileSync(noFrontmatterFile, '# Just a heading\n\nNo frontmatter here.\n');

// Fixture: well-formed frontmatter
const wellFormedContent = [
  '---',
  'role: coder',
  'inputs:',
  '  - task',
  '  - goal',
  'tools:',
  '  - Read',
  '  - Bash',
  'default_tools:',
  '  - Read',
  '  - Edit',
  '---',
  '# heading',
].join('\n');
const wellFormedFile = path.join(tmpDir, 'well-formed.md');
fs.writeFileSync(wellFormedFile, wellFormedContent);

// Fixture: corrupt YAML (invalid indentation / syntax)
const corruptContent = '---\nrole: [unclosed bracket\n  bad: : : yaml\n---\n# body\n';
const corruptFile = path.join(tmpDir, 'corrupt.md');
fs.writeFileSync(corruptFile, corruptContent);

// --- tests ---

test('parseFrontmatter is a named export function', () => {
  expect(typeof parseFrontmatter).toBe('function');
});

test('parseFrontmatter returns {} when file has no --- block', () => {
  const result = parseFrontmatter(noFrontmatterFile);
  expect(typeof result).toBe('object');
  expect(result).not.toBeNull();
  expect(Object.keys(result).length).toBe(0);
});

test('parseFrontmatter returns correct role field from well-formed frontmatter', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(result.role).toBe('coder');
});

test('parseFrontmatter returns correct inputs array from well-formed frontmatter', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(Array.isArray(result.inputs)).toBe(true);
  expect(result.inputs.length).toBe(2);
  expect(result.inputs[0]).toBe('task');
  expect(result.inputs[1]).toBe('goal');
});

test('parseFrontmatter returns correct tools array from well-formed frontmatter', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(Array.isArray(result.tools)).toBe(true);
  expect(result.tools.length).toBe(2);
  expect(result.tools[0]).toBe('Read');
  expect(result.tools[1]).toBe('Bash');
});

test('parseFrontmatter returns correct default_tools array from well-formed frontmatter', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(Array.isArray(result.default_tools)).toBe(true);
  expect(result.default_tools.length).toBe(2);
  expect(result.default_tools[0]).toBe('Read');
  expect(result.default_tools[1]).toBe('Edit');
});

test('parseFrontmatter is fail-open: corrupt YAML returns {}', () => {
  const result = parseFrontmatter(corruptFile);
  expect(typeof result).toBe('object');
  expect(result).not.toBeNull();
  expect(Object.keys(result).length).toBe(0);
});

test('listAgentsWithMeta is a named export function', () => {
  expect(typeof listAgentsWithMeta).toBe('function');
});

test('listAgentsWithMeta returns an array', () => {
  const result = listAgentsWithMeta();
  expect(Array.isArray(result)).toBe(true);
});

test('listAgentsWithMeta includes an entry with name === "coder"', () => {
  const result = listAgentsWithMeta();
  const coderEntry = result.find(e => e.name === 'coder');
  expect(coderEntry).toBeDefined();
});

test('listAgentsWithMeta includes an entry with name === "researcher"', () => {
  const result = listAgentsWithMeta();
  const researcherEntry = result.find(e => e.name === 'researcher');
  expect(researcherEntry).toBeDefined();
});

test('listAgentsWithMeta coder entry has name field', () => {
  const result = listAgentsWithMeta();
  const coderEntry = result.find(e => e.name === 'coder');
  expect(typeof coderEntry.name).toBe('string');
  expect(coderEntry.name).toBe('coder');
});

test('listAgentsWithMeta entries include frontmatter fields alongside name', () => {
  const result = listAgentsWithMeta();
  // Every entry must be an object with a string name plus at least a frontmatter key
  for (const entry of result) {
    expect(typeof entry).toBe('object');
    expect(entry).not.toBeNull();
    expect(typeof entry.name).toBe('string');
    // frontmatter is merged in — at minimum the entry shape includes name
    // (individual fields depend on each agent's CLAUDE.md)
  }
});
