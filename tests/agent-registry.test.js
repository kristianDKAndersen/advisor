import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// lib/agents.js — frontmatter parser + agent registry.
// Schema (standard Claude Code agent frontmatter):
//   name: <agent>
//   description: <one line>
//   allowed-tools: <comma-separated string>
// parseFrontmatter is unchanged: 'allowed-tools: a, b' is captured as the
// STRING 'a, b' under key 'allowed-tools' (string-field branch, not array).

import { parseFrontmatter, listAgentsWithMeta } from '../lib/agents.js';

// --- tmp fixture setup ---

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Fixture: .md file with no frontmatter block
const noFrontmatterFile = path.join(tmpDir, 'no-frontmatter.md');
fs.writeFileSync(noFrontmatterFile, '# Just a heading\n\nNo frontmatter here.\n');

// Fixture: well-formed frontmatter in the NEW schema
const wellFormedContent = [
  '---',
  'name: coder',
  'description: Implements fixes from a structured spec.',
  'allowed-tools: Read, Edit, Write',
  '---',
  '# heading',
].join('\n');
const wellFormedFile = path.join(tmpDir, 'well-formed.md');
fs.writeFileSync(wellFormedFile, wellFormedContent);

// Fixture: corrupt YAML (invalid indentation / syntax)
const corruptContent = '---\nname: [unclosed bracket\n  bad: : : yaml\n---\n# body\n';
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

test('parseFrontmatter returns correct name field from well-formed frontmatter', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(result.name).toBe('coder');
});

test('parseFrontmatter returns correct description field from well-formed frontmatter', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(result.description).toBe('Implements fixes from a structured spec.');
});

test('parseFrontmatter returns allowed-tools as a comma-separated STRING (not an array)', () => {
  const result = parseFrontmatter(wellFormedFile);
  expect(typeof result['allowed-tools']).toBe('string');
  expect(result['allowed-tools']).toBe('Read, Edit, Write');
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

test('every migrated agent exposes a non-empty description string', () => {
  const result = listAgentsWithMeta();
  for (const entry of result) {
    expect(typeof entry.description).toBe('string');
    expect(entry.description.length).toBeGreaterThan(0);
  }
});

test('every migrated agent exposes allowed-tools as a non-empty string', () => {
  const result = listAgentsWithMeta();
  for (const entry of result) {
    expect(typeof entry['allowed-tools']).toBe('string');
    expect(entry['allowed-tools'].length).toBeGreaterThan(0);
  }
});

test('coder allowed-tools string includes Edit', () => {
  const result = listAgentsWithMeta();
  const coderEntry = result.find(e => e.name === 'coder');
  expect(coderEntry['allowed-tools']).toContain('Edit');
});

test('the old vestigial fields (role/inputs/tools/default_tools) are gone from all agents', () => {
  const result = listAgentsWithMeta();
  for (const entry of result) {
    expect(entry.role).toBeUndefined();
    expect(entry.inputs).toBeUndefined();
    expect(entry.tools).toBeUndefined();
    expect(entry.default_tools).toBeUndefined();
  }
});

test('researcher retains default_next_agent === "evaluator"', () => {
  const result = listAgentsWithMeta();
  const researcherEntry = result.find(e => e.name === 'researcher');
  expect(researcherEntry.default_next_agent).toBe('evaluator');
});

test('listAgentsWithMeta entries each have a string name', () => {
  const result = listAgentsWithMeta();
  for (const entry of result) {
    expect(typeof entry).toBe('object');
    expect(entry).not.toBeNull();
    expect(typeof entry.name).toBe('string');
  }
});
