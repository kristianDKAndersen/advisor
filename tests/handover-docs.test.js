const { test, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SKILL = '.claude/skills/pre-compact/SKILL.md';

function recovery(md) {
  const i = md.indexOf('\n## Recovery');
  return i === -1 ? '' : md.slice(i);
}

test('docs-skill: pre-compact SKILL.md calls bin/handover-write and has no node -e snippet', () => {
  const md = read(SKILL);
  expect(md).toContain('bin/handover-write');
  expect(md).not.toContain('node -e');
  expect(md).not.toContain('readSessionState');
});

test('docs-skill: pre-compact SKILL.md last_edited is 2026-10-28 or later', () => {
  const m = read(SKILL).match(/^last_edited:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  expect(m).not.toBeNull();
  expect(m[1] >= '2026-10-28').toBe(true);
});

test('docs-skill: pre-compact SKILL.md passes --sid and notes via stdin heredoc', () => {
  const md = read(SKILL);
  expect(md).toMatch(/bin\/handover-write[^\n]*--sid/);
  expect(md).toMatch(/<<'?[A-Z_]+'?/);
});

test('docs-skill: pre-compact SKILL.md recovery section names status header, 30-day archive and bin/handover-resolve', () => {
  const rec = recovery(read(SKILL));
  expect(rec).toContain('status');
  expect(rec).toMatch(/30[- ]days?/);
  expect(rec).toContain('bin/handover-resolve');
  expect(rec).toMatch(/exit 4/i);
});

test('docs-changelog: doctrine-changelog has a 2026-10 entry naming handover-write', () => {
  const lines = read('decisions/doctrine-changelog.md').split('\n');
  const entry = lines.filter((l) => l.startsWith('- 2026-10:') && l.includes('bin/handover-write'));
  expect(entry.length).toBeGreaterThanOrEqual(1);
});

test('docs-changelog: handover entry covers status header, stale archive, INVALID, resolve exit codes and source', () => {
  const lines = read('decisions/doctrine-changelog.md').split('\n');
  const entry = lines.find((l) => l.startsWith('- 2026-10:') && l.includes('bin/handover-write')) || '';
  expect(entry).toMatch(/status header/i);
  expect(entry).toMatch(/FINAL OUTCOME/);
  expect(entry).toMatch(/30 days|30d/);
  expect(entry).toContain('INVALID');
  expect(entry).toMatch(/exit 4/);
  expect(entry).toContain('ai-koala');
});
