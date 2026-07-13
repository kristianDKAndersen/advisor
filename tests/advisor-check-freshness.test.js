import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'advisor-check-freshness');

function run(args) {
  try {
    const out = execFileSync(SCRIPT, args, { encoding: 'utf8' });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'adv-freshness-test-'));
}

function writeSpawn(root, name, content) {
  const dir = join(root, 'spawns', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), content);
  return join(dir, 'CLAUDE.md');
}

function writeSkill(root, name, content) {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  return join(dir, 'SKILL.md');
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

describe('advisor-check-freshness', () => {
  test('all compliant -> exit 0', () => {
    const root = makeRoot();
    writeSpawn(root, 'coder', `---\nname: coder\nlast_edited: ${isoDaysAgo(5)}\n---\n# Coder\n`);
    writeSkill(root, 'brief', `---\nname: brief\nlast_edited: ${isoDaysAgo(5)}\n---\n# Brief\n`);

    const result = run(['--root', root]);
    expect(result.code).toBe(0);
  });

  test('missing key -> exit 1 naming offender', () => {
    const root = makeRoot();
    const missingPath = writeSpawn(root, 'planner', `---\nname: planner\n---\n# Planner\n`);
    writeSkill(root, 'brief', `---\nname: brief\nlast_edited: ${isoDaysAgo(5)}\n---\n# Brief\n`);

    const result = run(['--root', root]);
    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('spawns/planner/CLAUDE.md');
  });

  test('stale >180d -> exit 0 with warning', () => {
    const root = makeRoot();
    writeSpawn(root, 'coder', `---\nname: coder\nlast_edited: ${isoDaysAgo(400)}\n---\n# Coder\n`);

    const result = run(['--root', root]);
    expect(result.code).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/stale/i);
    expect(output).toContain('spawns/coder/CLAUDE.md');
  });

  test('--fix adds the key idempotently and preserves other frontmatter keys byte-for-byte', () => {
    const root = makeRoot();
    const path = writeSpawn(root, 'researcher', `---\nname: researcher\ndescription: does research\n---\n# Researcher\nBody text.\n`);

    const first = run(['--root', root, '--fix']);
    expect(first.code).toBe(0);

    const afterFirst = readFileSync(path, 'utf8');
    expect(afterFirst).toContain('name: researcher');
    expect(afterFirst).toContain('description: does research');
    expect(afterFirst).toMatch(/last_edited: \d{4}-\d{2}-\d{2}/);
    expect(afterFirst).toContain('# Researcher\nBody text.\n');

    const second = run(['--root', root, '--fix']);
    expect(second.code).toBe(0);
    const afterSecond = readFileSync(path, 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });

  test('--fix creates a frontmatter block when none exists', () => {
    const root = makeRoot();
    const path = writeSkill(root, 'nofm', `# No Frontmatter\nJust body.\n`);

    const result = run(['--root', root, '--fix']);
    expect(result.code).toBe(0);

    const after = readFileSync(path, 'utf8');
    expect(after).toMatch(/^---\n/);
    expect(after).toMatch(/last_edited: \d{4}-\d{2}-\d{2}/);
    expect(after).toContain('# No Frontmatter\nJust body.\n');
  });

  test('--json emits parseable JSON', () => {
    const root = makeRoot();
    writeSpawn(root, 'coder', `---\nname: coder\nlast_edited: ${isoDaysAgo(5)}\n---\n# Coder\n`);
    writeSpawn(root, 'planner', `---\nname: planner\n---\n# Planner\n`);

    const result = run(['--root', root, '--json']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed.offenders)).toBe(true);
    expect(parsed.offenders.some((o) => o.includes('spawns/planner/CLAUDE.md'))).toBe(true);
  });
});
