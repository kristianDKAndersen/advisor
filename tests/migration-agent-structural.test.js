import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listAgentsWithMeta } from '../lib/agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const CLAUDE_MD_PATH = path.resolve(root, 'spawns/migration/CLAUDE.md');

function getMigrationContent() {
  if (!fs.existsSync(CLAUDE_MD_PATH)) throw new Error('spawns/migration/CLAUDE.md does not exist');
  return fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
}

// --- Discoverability ---

test('spawns/migration/CLAUDE.md exists', () => {
  expect(fs.existsSync(CLAUDE_MD_PATH)).toBe(true);
});

test('spawns/migration/CLAUDE.md is discovered by lib/agents.js listAgentsWithMeta', () => {
  const agents = listAgentsWithMeta();
  const found = agents.find(a => a.name === 'migration' || (a.path && a.path.includes('spawns/migration')));
  expect(found).toBeDefined();
});

test('discovered migration agent has name: migration in frontmatter', () => {
  const agents = listAgentsWithMeta();
  const found = agents.find(a => a.name === 'migration');
  expect(found).toBeDefined();
  expect(found.name).toBe('migration');
});

// --- Required sections ---

test('required section: two-phase commit schema (commit_1_literal and commit_2_idiomatic)', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/commit_1_literal|commit.*1.*literal/i);
  expect(c).toMatch(/commit_2_idiomatic|commit.*2.*idiomatic/i);
});

test('required section: per-subsystem mode detection Step 7.1 present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/7\.1|per.subsystem mode detection|subsystem.*mode.*detection/i);
});

test('required section: dead-code pre-pass Step 0.5 present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/0\.5|[Dd]ead.code pre.pass/);
});

test('required section: cheap-first cascade Step 7.4 present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/7\.4|cheap.first.*cascade|cascade.*cheap.first/i);
});

test('required section: self-check present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/[Ss]elf.check/);
});

test('required section: ## Constraints present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/##\s+Constraints/);
});

// --- FIX 1: dead-code detection corrected ---

test('FIX 1: no codegraphcontext references', () => {
  const c = getMigrationContent();
  expect(c).not.toMatch(/codegraphcontext/i);
});

test('FIX 1: no graphify affected --unreachable flag', () => {
  const c = getMigrationContent();
  expect(c).not.toMatch(/graphify affected --unreachable/);
});

test('FIX 1: per-symbol graphify affected check for dead detection', () => {
  const c = getMigrationContent();
  // Should use graphify affected "<symbol>" --graph
  expect(c).toMatch(/graphify affected.*--graph|graphify affected.*graph/i);
});

test('FIX 1: vulture present for Python dead-code', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/vulture/);
});

test('FIX 1: ts-prune present for TS/JS dead-code', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/ts-prune/);
});

// --- FIX 2: Step 0.2 role-bleed removed ---

test('FIX 2: Step 0.2 instructs agent to read pre-staged files', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/commit_history\.txt|pre.staged|pre-staged/i);
});

test('FIX 2: advisor-side git commands not embedded as primary Step 0.2 commands', () => {
  const c = getMigrationContent();
  // The draft had "Run these BEFORE summoning the migration worker (advisor responsibility):"
  // That block belongs only in PIPELINE.md, not in the agent CLAUDE.md
  expect(c).not.toMatch(/Run these BEFORE summoning the migration worker/);
});

// --- spawns/migration/idiom-taxonomy.md exists ---

test('spawns/migration/idiom-taxonomy.md exists', () => {
  const p = path.resolve(root, 'spawns/migration/idiom-taxonomy.md');
  expect(fs.existsSync(p)).toBe(true);
});

test('spawns/migration/idiom-taxonomy.md has >= 8 source language rows', () => {
  const p = path.resolve(root, 'spawns/migration/idiom-taxonomy.md');
  if (!fs.existsSync(p)) throw new Error('idiom-taxonomy.md does not exist');
  const c = fs.readFileSync(p, 'utf8');
  const rows = (c.match(/^\|\s*\d+\s*\|/gm) || []).length;
  expect(rows).toBeGreaterThanOrEqual(8);
});

// --- spawns/migration/PIPELINE.md exists ---

test('spawns/migration/PIPELINE.md exists', () => {
  const p = path.resolve(root, 'spawns/migration/PIPELINE.md');
  expect(fs.existsSync(p)).toBe(true);
});

test('PIPELINE.md Phase 0 has pre-staging commands', () => {
  const p = path.resolve(root, 'spawns/migration/PIPELINE.md');
  if (!fs.existsSync(p)) throw new Error('PIPELINE.md does not exist');
  const c = fs.readFileSync(p, 'utf8');
  expect(c).toMatch(/Phase 0/);
  expect(c).toMatch(/commit_history\.txt/);
});
