import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const claudeMd = fs.readFileSync(
  path.resolve(root, 'spawns/code-reviewer/CLAUDE.md'),
  'utf8'
);

// ---------------------------------------------------------------------------
// W1: Review-quality prompt upgrades
// ---------------------------------------------------------------------------

test('W1: project-rule injection step — find CLAUDE.md and REVIEW.md', () => {
  expect(claudeMd).toMatch(/find.*maxdepth.*CLAUDE\.md|REVIEW\.md.*maxdepth|read.*project.*rules/i);
});

test('W1: do-not-flag blocklist present', () => {
  expect(claudeMd).toMatch(/do not flag|blocklist|precision over recall/i);
});

test('W1: Simplicity dimension in Dimensions Checked table', () => {
  expect(claudeMd).toMatch(/Simplicity/);
});

test('W1: AI-default naming anti-pattern named', () => {
  expect(claudeMd).toMatch(/AI.default naming/i);
});

test('W1: Guessed defaults anti-pattern named', () => {
  expect(claudeMd).toMatch(/[Gg]uessed defaults/);
});

test('W1: Misplaced domain logic anti-pattern named', () => {
  expect(claudeMd).toMatch(/[Mm]isplaced domain logic/);
});

test('W1: gap sweep step present', () => {
  expect(claudeMd).toMatch(/gap sweep/i);
});

test('W1: nit cap of 5 enforced', () => {
  expect(claudeMd).toMatch(/5 [Nn]its|nit cap|[Aa]t most 5|five nits/i);
});

test('W1: effort frontmatter field declared', () => {
  expect(claudeMd).toMatch(/effort:/);
});

// ---------------------------------------------------------------------------
// W2: Big-picture context layer
// ---------------------------------------------------------------------------

test('W2: context-first phasing — read adjacent files before dimension passes', () => {
  expect(claudeMd).toMatch(/[Cc]ontext.first|before.*dimension pass|adjacent.*files.*before/i);
});

test('W2: git log hotspot/churn prioritization uses --since', () => {
  expect(claudeMd).toMatch(/git log.*--since|--since.*git log/);
});

test('W2: co-change coupling check uses --name-only', () => {
  expect(claudeMd).toMatch(/--name-only/);
});

test('W2: temporal pass uses git log -5 --oneline', () => {
  expect(claudeMd).toMatch(/git log -5 --oneline/);
});

test('W2: three-tier token budget defines Tier 1, Tier 2, Tier 3', () => {
  expect(claudeMd).toMatch(/Tier 1/);
  expect(claudeMd).toMatch(/Tier 2/);
  expect(claudeMd).toMatch(/Tier 3/);
});

test('W2: two-hop dependency tracing mentioned', () => {
  expect(claudeMd).toMatch(/two.hop/i);
});

// ---------------------------------------------------------------------------
// W3: graphify integration tier
// ---------------------------------------------------------------------------

test('W3: Graph Context subsection present', () => {
  expect(claudeMd).toMatch(/#+\s*Graph Context/i);
});

test('W3: graphify update command documented', () => {
  expect(claudeMd).toMatch(/graphify update/);
});

test('W3: graphify affected command documented', () => {
  expect(claudeMd).toMatch(/graphify affected/);
});

test('W3: graphify path command documented', () => {
  expect(claudeMd).toMatch(/graphify path/);
});

test('W3: graphify explain command documented', () => {
  expect(claudeMd).toMatch(/graphify explain/);
});

test('W3: conditional two-part trigger checks graphify-out/graph.json', () => {
  expect(claudeMd).toMatch(/graphify-out\/graph\.json/);
});

test('W3: fallback ladder has 5 rungs — aider rung present', () => {
  expect(claudeMd).toMatch(/aider/);
});

test('W3: fallback ladder has 5 rungs — ctags rung present', () => {
  expect(claudeMd).toMatch(/ctags/);
});

// ---------------------------------------------------------------------------
// W4: Optimizer capability
// ---------------------------------------------------------------------------

test('W4: Optimization Opportunities output section present', () => {
  expect(claudeMd).toMatch(/#+\s*Optimization Opportunities/i);
});

test('W4: file-level optimizer dimension — Algorithmic Anti-Patterns', () => {
  expect(claudeMd).toMatch(/Algorithmic Anti.Patterns|Algorithmic.anti.patterns/i);
});

test('W4: file-level optimizer dimension — Redundant Allocation', () => {
  expect(claudeMd).toMatch(/Redundant Allocation/i);
});

test('W4: file-level optimizer dimension — Complexity', () => {
  expect(claudeMd).toMatch(/Complexity.*Maintainability|Complexity.*Smell/i);
});

test('W4: file-level optimizer dimension — Speculative Generality', () => {
  expect(claudeMd).toMatch(/Speculative Generality/i);
});

test('W4: graph-class optimizer dimension — N+1 Query', () => {
  expect(claudeMd).toMatch(/N\+1 Query/i);
});

test('W4: graph-class optimizer dimension — Dead Exports', () => {
  expect(claudeMd).toMatch(/Dead Exports/i);
});

test('W4: graph-class optimizer dimension — Architectural Smells', () => {
  expect(claudeMd).toMatch(/Architectural Smells/i);
});

test('W4: graph-class optimizer dimension — Feature Envy', () => {
  expect(claudeMd).toMatch(/Feature Envy/i);
});

test('W4: optimizer-taxonomy.md referenced in CLAUDE.md', () => {
  expect(claudeMd).toMatch(/optimizer-taxonomy\.md/);
});

// ---------------------------------------------------------------------------
// New files: existence assertions
// ---------------------------------------------------------------------------

test('new-file: spawns/code-reviewer/optimizer-taxonomy.md exists', () => {
  const p = path.resolve(root, 'spawns/code-reviewer/optimizer-taxonomy.md');
  expect(fs.existsSync(p)).toBe(true);
});

test('new-file: optimizer-taxonomy.md has >= 10 categories', () => {
  const p = path.resolve(root, 'spawns/code-reviewer/optimizer-taxonomy.md');
  if (!fs.existsSync(p)) {
    throw new Error('optimizer-taxonomy.md does not exist');
  }
  const content = fs.readFileSync(p, 'utf8');
  // Count table rows starting with a pipe + digit or numbered list items
  const rows = (content.match(/^\|\s*\d+/gm) || []).length;
  const numbered = (content.match(/^\d+\.\s+\*\*/gm) || []).length;
  expect(Math.max(rows, numbered)).toBeGreaterThanOrEqual(10);
});

test('new-file: lib/graphify-setup.sh exists', () => {
  const p = path.resolve(root, 'lib/graphify-setup.sh');
  expect(fs.existsSync(p)).toBe(true);
});

test('new-file: lib/graphify-setup.sh contains graphify update', () => {
  const p = path.resolve(root, 'lib/graphify-setup.sh');
  if (!fs.existsSync(p)) throw new Error('lib/graphify-setup.sh does not exist');
  const content = fs.readFileSync(p, 'utf8');
  expect(content).toMatch(/graphify update/);
});

test('new-file: lib/graphify-setup.sh contains hook install', () => {
  const p = path.resolve(root, 'lib/graphify-setup.sh');
  if (!fs.existsSync(p)) throw new Error('lib/graphify-setup.sh does not exist');
  const content = fs.readFileSync(p, 'utf8');
  expect(content).toMatch(/hook install|hook.*install/);
});

test('new-file: lib/graphify-setup.sh contains command -v guard', () => {
  const p = path.resolve(root, 'lib/graphify-setup.sh');
  if (!fs.existsSync(p)) throw new Error('lib/graphify-setup.sh does not exist');
  const content = fs.readFileSync(p, 'utf8');
  expect(content).toMatch(/command -v graphify/);
});
