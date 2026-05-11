import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseFrontmatter } from '../lib/agents.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-default-next-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const withFieldFile = path.join(tmpDir, 'with-field.md');
fs.writeFileSync(
  withFieldFile,
  ['---', 'role: researcher', 'default_next_agent: evaluator', '---', '# body'].join('\n'),
);

const withoutFieldFile = path.join(tmpDir, 'without-field.md');
fs.writeFileSync(
  withoutFieldFile,
  ['---', 'role: evaluator', '---', '# body'].join('\n'),
);

test('parseFrontmatter returns default_next_agent when present', () => {
  const result = parseFrontmatter(withFieldFile);
  expect(result.default_next_agent).toBe('evaluator');
});

test('parseFrontmatter returns undefined for default_next_agent when absent', () => {
  const result = parseFrontmatter(withoutFieldFile);
  expect(result.default_next_agent).toBeUndefined();
});
