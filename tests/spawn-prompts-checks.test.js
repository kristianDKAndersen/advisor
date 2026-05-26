import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const creative = fs.readFileSync(path.resolve(__dirname, '../spawns/creative/CLAUDE.md'), 'utf8');
const spec = fs.readFileSync(path.resolve(__dirname, '../spawns/spec/CLAUDE.md'), 'utf8');
const factChecker = fs.readFileSync(path.resolve(__dirname, '../spawns/fact-checker/CLAUDE.md'), 'utf8');

// creative: must name the skill and describe the pipeline flow
test('spawns/creative mentions creative-thinking skill', () => {
  expect(creative).toMatch(/creative-thinking/);
});

test('spawns/creative describes mapper step', () => {
  expect(creative).toMatch(/mapper/);
});

test('spawns/creative describes 3-of-5 personas step', () => {
  expect(creative).toMatch(/3 of 5 personas/);
});

test('spawns/creative describes synthesizer step', () => {
  expect(creative).toMatch(/synthesizer/);
});

// spec: must reference the tournament contract by name
test('spawns/spec references tournament-contract.md by name', () => {
  expect(spec).toMatch(/tournament-contract/);
});

// fact-checker: must mention all four trigger categories
test('spawns/fact-checker mentions pricing trigger category', () => {
  expect(factChecker).toMatch(/pricing/i);
});

test('spawns/fact-checker mentions licensing trigger category', () => {
  expect(factChecker).toMatch(/licensing/i);
});

test('spawns/fact-checker mentions availability trigger category', () => {
  expect(factChecker).toMatch(/availability/i);
});

test('spawns/fact-checker mentions version trigger category', () => {
  expect(factChecker).toMatch(/version/i);
});
