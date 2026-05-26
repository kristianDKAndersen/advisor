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
