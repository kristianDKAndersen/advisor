import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listAgentsWithMeta } from '../lib/agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const CLAUDE_MD_PATH = path.resolve(root, 'spawns/migration/CLAUDE.md');
const SKILL_MD_PATH = path.resolve(root, 'spawns/migration/.claude/skills/migration/SKILL.md');
const RESOURCES_PATH = path.resolve(root, 'spawns/migration/.claude/skills/migration/resources');

function getMigrationContent() {
  if (!fs.existsSync(CLAUDE_MD_PATH)) throw new Error('spawns/migration/CLAUDE.md does not exist');
  return fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
}

function getSkillContent() {
  if (!fs.existsSync(SKILL_MD_PATH)) throw new Error('spawns/migration/.claude/skills/migration/SKILL.md does not exist');
  return fs.readFileSync(SKILL_MD_PATH, 'utf8');
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
  const c = getSkillContent();
  expect(c).toMatch(/7\.1|per.subsystem mode detection|subsystem.*mode.*detection/i);
});

test('required section: dead-code pre-pass Step 0.5 present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/0\.5|[Dd]ead.code pre.pass/);
});

test('required section: cheap-first cascade Step 7.4 present', () => {
  const c = getSkillContent();
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
  const c = getSkillContent();
  expect(c).not.toMatch(/codegraphcontext/i);
});

test('FIX 1: no graphify affected --unreachable flag', () => {
  const c = getSkillContent();
  expect(c).not.toMatch(/graphify affected --unreachable/);
});

test('FIX 1: per-symbol graphify affected check for dead detection', () => {
  const c = getSkillContent();
  // Should use graphify affected "<symbol>" --graph
  expect(c).toMatch(/graphify affected.*--graph|graphify affected.*graph/i);
});

test('FIX 1: vulture present for Python dead-code', () => {
  const c = getSkillContent();
  expect(c).toMatch(/vulture/);
});

test('FIX 1: ts-prune present for TS/JS dead-code', () => {
  const c = getSkillContent();
  expect(c).toMatch(/ts-prune/);
});

// --- FIX 2: Step 0.2 role-bleed removed ---

test('FIX 2: Step 0.2 instructs agent to read pre-staged files', () => {
  const c = getSkillContent();
  expect(c).toMatch(/commit_history\.txt|pre.staged|pre-staged/i);
});

test('FIX 2: advisor-side git commands not embedded as primary Step 0.2 commands', () => {
  const c = getMigrationContent();
  // The pre-staging block belongs only in resources/pipeline.md, not in the agent CLAUDE.md
  expect(c).not.toMatch(/Run these BEFORE summoning the migration worker/);
});

// --- resources/idiom-taxonomy.md exists ---

test('resources/idiom-taxonomy.md exists', () => {
  const p = path.join(RESOURCES_PATH, 'idiom-taxonomy.md');
  expect(fs.existsSync(p)).toBe(true);
});

test('resources/idiom-taxonomy.md has >= 8 source language rows', () => {
  const p = path.join(RESOURCES_PATH, 'idiom-taxonomy.md');
  if (!fs.existsSync(p)) throw new Error('idiom-taxonomy.md does not exist');
  const c = fs.readFileSync(p, 'utf8');
  const rows = (c.match(/^\|\s*\d+\s*\|/gm) || []).length;
  expect(rows).toBeGreaterThanOrEqual(8);
});

// --- resources/pipeline.md exists ---

test('resources/pipeline.md exists', () => {
  const p = path.join(RESOURCES_PATH, 'pipeline.md');
  expect(fs.existsSync(p)).toBe(true);
});

test('resources/pipeline.md Phase 0 has pre-staging commands', () => {
  const p = path.join(RESOURCES_PATH, 'pipeline.md');
  if (!fs.existsSync(p)) throw new Error('pipeline.md does not exist');
  const c = fs.readFileSync(p, 'utf8');
  expect(c).toMatch(/Phase 0/);
  expect(c).toMatch(/commit_history\.txt/);
});

// --- New structure: SKILL.md exists with valid YAML frontmatter ---

test('SKILL.md exists at .claude/skills/migration/SKILL.md', () => {
  expect(fs.existsSync(SKILL_MD_PATH)).toBe(true);
});

test('SKILL.md frontmatter: name=migration', () => {
  const c = getSkillContent();
  const fm = c.match(/^---\n([\s\S]*?)\n---/);
  expect(fm).not.toBeNull();
  expect(fm[1]).toMatch(/^name:\s*migration\s*$/m);
});

test('SKILL.md frontmatter: non-empty description', () => {
  const c = getSkillContent();
  const fm = c.match(/^---\n([\s\S]*?)\n---/);
  expect(fm).not.toBeNull();
  const descMatch = fm[1].match(/^description:\s*(.+)$/m);
  expect(descMatch).not.toBeNull();
  expect(descMatch[1].trim().length).toBeGreaterThan(0);
});

test('SKILL.md frontmatter: allowed-tools present', () => {
  const c = getSkillContent();
  const fm = c.match(/^---\n([\s\S]*?)\n---/);
  expect(fm).not.toBeNull();
  expect(fm[1]).toMatch(/^allowed-tools:/m);
});

// --- New structure: resources/php-2016-idioms.md exists ---

test('resources/php-2016-idioms.md exists', () => {
  const p = path.join(RESOURCES_PATH, 'php-2016-idioms.md');
  expect(fs.existsSync(p)).toBe(true);
});

// --- New structure: slim CLAUDE.md has mandatory Step 0 skill invoke ---

test('slim CLAUDE.md contains mandatory Step 0 skill-invoke (/migration)', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/\/migration/);
});

// --- New structure: slim CLAUDE.md retains inline safety principles ---

test('slim CLAUDE.md: plan-never-implement principle present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/[Pp]lan.*never.*implement|never.*implement|plan the migration/i);
});

test('slim CLAUDE.md: two-phase principle present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/[Tt]wo.phase/);
});

test('slim CLAUDE.md: self-check gate present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/[Ss]elf.check/);
});

test('slim CLAUDE.md: never-write-code constraint present', () => {
  const c = getMigrationContent();
  expect(c).toMatch(/[Nn]ever.*write.*code|[Nn]ever write.*edit.*commit/i);
});
