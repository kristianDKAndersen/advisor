import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveNextAgent } from '../lib/chain.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkAgent(agentName, frontmatterLines) {
  const agentDir = path.join(tmpDir, agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  const content = ['---', ...frontmatterLines, '---', '# body'].join('\n');
  fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), content);
}

mkAgent('researcher', ['role: researcher', 'default_next_agent: evaluator']);
mkAgent('evaluator', ['role: evaluator']);
mkAgent('empty-next', ['role: empty-next', 'default_next_agent:']);

test('resolveNextAgent returns next agent when default_next_agent is set', () => {
  expect(resolveNextAgent('researcher', tmpDir)).toBe('evaluator');
});

test('resolveNextAgent returns null when no default_next_agent', () => {
  expect(resolveNextAgent('evaluator', tmpDir)).toBeNull();
});

test('resolveNextAgent returns null for unknown agent (no throw)', () => {
  expect(resolveNextAgent('does-not-exist', tmpDir)).toBeNull();
});

test('resolveNextAgent returns null when default_next_agent is empty', () => {
  expect(resolveNextAgent('empty-next', tmpDir)).toBeNull();
});
