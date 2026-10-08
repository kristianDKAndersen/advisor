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
  expect(creative).toMatch(/3 of (the )?5/);
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

// Spawn settings centralization tests (Fix #4)
test('spawns/*/.claude/settings.json: NO PostToolUse worker-hook blocks remain (Fix #4)', () => {
  const spawnDir = path.resolve(__dirname, '../spawns');
  const agents = fs.readdirSync(spawnDir);
  for (const agent of agents) {
    const settingsPath = path.join(spawnDir, agent, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) continue;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Must not have PostToolUse hooks in spawn settings
    expect(settings.hooks?.PostToolUse).toBeUndefined();
  }
});

test('spawns/*/.claude/settings.json: NO ADVISOR_WORKER_HOOKS env entries remain (Fix #4)', () => {
  const spawnDir = path.resolve(__dirname, '../spawns');
  const agents = fs.readdirSync(spawnDir);
  for (const agent of agents) {
    const settingsPath = path.join(spawnDir, agent, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) continue;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Must not have ADVISOR_WORKER_HOOKS in spawn env
    expect(settings.env?.ADVISOR_WORKER_HOOKS).toBeUndefined();
  }
});

// N5: unattended brainstormer must not wait on a participant who cannot answer
const brainstormer = fs.readFileSync(path.resolve(__dirname, '../spawns/brainstormer/CLAUDE.md'), 'utf8');
const facilitation = fs.readFileSync(path.resolve(__dirname, '../spawns/brainstormer/.claude/skills/facilitation/SKILL.md'), 'utf8');
const coder = fs.readFileSync(path.resolve(__dirname, '../spawns/coder/CLAUDE.md'), 'utf8');

test('spawns/brainstormer: summoned brief is the participant input, answered from the brief with stated assumptions', () => {
  expect(brainstormer).toMatch(/brief is the participant/i);
  expect(brainstormer).toMatch(/state (your )?assumptions/i);
});

test('spawns/brainstormer: one batched question to the Advisor only when a load-bearing answer is absent', () => {
  expect(brainstormer).toMatch(/ONE batched `question`/);
  expect(brainstormer).toMatch(/load-bearing/);
  expect(brainstormer).toMatch(/worker-protocol/);
});

test('spawns/brainstormer facilitation: elicitation is interactive only for a live human, else answered from brief', () => {
  expect(facilitation).toMatch(/Elicitation \(live human: 1 question per turn; wait for answer/);
  expect(facilitation).toMatch(/summoned\/unattended: answer each from the brief/i);
});

test('spawns/coder: spawns/ and agent/skill prompt files are changed with Edit at real path, never bulk scripts or cross-run copies', () => {
  expect(coder).toMatch(/under `spawns\/`/);
  expect(coder).toMatch(/Edit` tool at (their|its) real path/);
  expect(coder).toMatch(/never bulk-apply scripts or copy files from other run dirs/i);
  expect(coder).toMatch(/instruction poisoning/);
});

test('N5/N1 edited prompt files carry last_edited 2026-10-08', () => {
  for (const f of [brainstormer, facilitation, coder]) {
    expect(f).toMatch(/^last_edited: 2026-10-08$/m);
  }
});
