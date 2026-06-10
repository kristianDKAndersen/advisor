import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const claudeMd = path.resolve(__dirname, '../spawns/deep-researcher/CLAUDE.md');
const content = fs.readFileSync(claudeMd, 'utf8');

test('spawns/deep-researcher/CLAUDE.md contains no reference to bias-auditor', () => {
  const matches = content.match(/bias-auditor/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md contains no reference to report-architect', () => {
  const matches = content.match(/report-architect/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md uses --from deep-researcher (not --from researcher)', () => {
  const wrongFrom = content.match(/--from researcher(?!-)/g);
  expect(wrongFrom).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md contains no agent_type="fact-checker"', () => {
  const matches = content.match(/agent_type\s*=\s*["']fact-checker["']/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md contains no agent_type="planner"', () => {
  const matches = content.match(/agent_type\s*=\s*["']planner["']/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md allowed-tools includes Task', () => {
  const m = content.match(/^allowed-tools:\s*(.+)$/m);
  expect(m).toBeTruthy();
  if (m) {
    expect(m[1]).toContain('Task');
  }
});
