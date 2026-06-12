import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const LINTER = path.join(REPO_ROOT, 'lib', 'hooks', 'agents-md-lint.js');

// ── helpers ──────────────────────────────────────────────────────────────────

const VALID_DOC = `---
scope: "lib/ directory — runtime modules"
last_updated_by: "sid:1781300677-a8c0ba seq:3"
last_updated_ts: "2026-06-12T14:30:00Z"
---

# lib/

Some body text.
`;

function runLinter(stdin, args = []) {
  return spawnSync('node', [LINTER, ...args], {
    input: stdin,
    encoding: 'utf8',
  });
}

function runCommitGate(cmd, cwd, stagedFiles = []) {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: cmd },
  });
  return spawnSync('node', [LINTER, '--commit-gate'], {
    input,
    encoding: 'utf8',
    cwd,
  });
}

// ── Lint rules: module API ────────────────────────────────────────────────────

const { lint } = await import(LINTER);

describe('lint() — module API', () => {
  test('valid document returns no violations', () => {
    expect(lint(VALID_DOC, 'AGENTS.md')).toEqual([]);
  });

  test('LR-1: missing frontmatter block (no opening ---)', () => {
    const doc = '# No frontmatter\nsome text\n';
    const v = lint(doc, 'AGENTS.md');
    expect(v.length).toBe(1);
    expect(v[0]).toContain('missing YAML frontmatter block');
    expect(v[0]).toContain('AGENTS.md');
  });

  test('LR-1: stops after first error when frontmatter absent', () => {
    const doc = '# No frontmatter\n';
    const v = lint(doc, 'f.md');
    expect(v.length).toBe(1);
  });

  test('LR-2: missing scope field', () => {
    const doc = `---\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n# body\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('missing required frontmatter field: scope'))).toBe(true);
  });

  test('LR-2: empty scope value', () => {
    const doc = `---\nscope: ""\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('missing required frontmatter field: scope'))).toBe(true);
  });

  test('LR-3: missing last_updated_by field', () => {
    const doc = `---\nscope: "some scope"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('missing required frontmatter field: last_updated_by'))).toBe(true);
  });

  test('LR-4: missing last_updated_ts field', () => {
    const doc = `---\nscope: "some scope"\nlast_updated_by: "sid:x seq:1"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('missing required frontmatter field: last_updated_ts'))).toBe(true);
  });

  test('LR-5: malformed last_updated_by — missing sid: prefix', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "1781300677-a8c0ba seq:3"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('malformed last_updated_by'))).toBe(true);
  });

  test('LR-5: malformed last_updated_by — seq is not digits', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:abc seq:three"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('malformed last_updated_by'))).toBe(true);
  });

  test('LR-5: malformed last_updated_by — double space', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:abc  seq:1"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('malformed last_updated_by'))).toBe(true);
  });

  test('LR-5: sid:manual seq:0 is accepted', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:manual seq:0"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('last_updated_by'))).toBe(false);
  });

  test('LR-6: malformed last_updated_ts — date only', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-06-12"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('malformed last_updated_ts'))).toBe(true);
  });

  test('LR-6: malformed last_updated_ts — missing Z', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-06-12T14:30:00"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('malformed last_updated_ts'))).toBe(true);
  });

  test('LR-6: malformed last_updated_ts — missing seconds', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-06-12T14:30Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('malformed last_updated_ts'))).toBe(true);
  });

  test('LR-6: millisecond precision is accepted', () => {
    const doc = `---\nscope: "s"\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-06-12T14:30:00.123Z"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    expect(v.some(m => m.includes('last_updated_ts'))).toBe(false);
  });

  test('multiple violations are all reported', () => {
    const doc = `---\nlast_updated_by: "bad-format"\n---\n`;
    const v = lint(doc, 'AGENTS.md');
    // missing scope, malformed last_updated_by, missing last_updated_ts
    expect(v.length).toBeGreaterThanOrEqual(3);
  });
});

// ── CLI stdin mode ────────────────────────────────────────────────────────────

describe('CLI — stdin mode', () => {
  test('valid document exits 0', () => {
    const r = runLinter(VALID_DOC);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  test('non-frontmatter document exits 1', () => {
    const r = runLinter('# Just a heading\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing YAML frontmatter block');
  });

  test('missing scope exits 1 and names the rule', () => {
    const doc = `---\nlast_updated_by: "sid:x seq:1"\nlast_updated_ts: "2026-01-01T00:00:00Z"\n---\n`;
    const r = runLinter(doc);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('scope');
  });
});

// ── CLI --file mode ───────────────────────────────────────────────────────────

describe('CLI — --file mode', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-lint-file-'));
  });
  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid file exits 0', () => {
    const f = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(f, VALID_DOC);
    const r = spawnSync('node', [LINTER, '--file', f], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  test('invalid file exits 1', () => {
    const f = path.join(tmpDir, 'BAD.md');
    fs.writeFileSync(f, '# No frontmatter\n');
    const r = spawnSync('node', [LINTER, '--file', f], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing YAML frontmatter block');
  });
});

// ── Commit-gate mode ──────────────────────────────────────────────────────────

describe('commit-gate — PreToolUse[Bash] mode', () => {
  let gitRepo;

  beforeAll(() => {
    gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-gate-'));
    spawnSync('git', ['init'], { cwd: gitRepo });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: gitRepo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepo });
    // Initial commit so HEAD exists
    fs.writeFileSync(path.join(gitRepo, 'README.md'), '# test\n');
    spawnSync('git', ['add', 'README.md'], { cwd: gitRepo });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: gitRepo });
  });

  afterAll(() => {
    if (gitRepo) fs.rmSync(gitRepo, { recursive: true, force: true });
  });

  test('non-commit bash command exits 0 without linting', () => {
    const r = runCommitGate('ls -la', gitRepo);
    expect(r.status).toBe(0);
  });

  test('git commit with no staged AGENTS.md exits 0', () => {
    // Stage only a non-AGENTS.md file
    fs.writeFileSync(path.join(gitRepo, 'foo.js'), 'const x = 1;\n');
    spawnSync('git', ['add', 'foo.js'], { cwd: gitRepo });
    const r = runCommitGate('git commit -m "add foo"', gitRepo);
    expect(r.status).toBe(0);
    // Clean up staged file so it doesn't affect later tests
    spawnSync('git', ['reset', 'HEAD', 'foo.js'], { cwd: gitRepo });
    fs.unlinkSync(path.join(gitRepo, 'foo.js'));
  });

  test('git commit with valid staged AGENTS.md exits 0', () => {
    const agentsFile = path.join(gitRepo, 'AGENTS.md');
    fs.writeFileSync(agentsFile, VALID_DOC);
    spawnSync('git', ['add', 'AGENTS.md'], { cwd: gitRepo });
    const r = runCommitGate('git commit -m "add docs"', gitRepo);
    expect(r.status).toBe(0);
    spawnSync('git', ['reset', 'HEAD', 'AGENTS.md'], { cwd: gitRepo });
    fs.unlinkSync(agentsFile);
  });

  test('git commit with invalid staged AGENTS.md exits 2', () => {
    const agentsFile = path.join(gitRepo, 'AGENTS.md');
    fs.writeFileSync(agentsFile, '# Missing frontmatter\n');
    spawnSync('git', ['add', 'AGENTS.md'], { cwd: gitRepo });
    const r = runCommitGate('git commit -m "bad"', gitRepo);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing YAML frontmatter block');
    spawnSync('git', ['reset', 'HEAD', 'AGENTS.md'], { cwd: gitRepo });
    fs.unlinkSync(agentsFile);
  });

  test('git commit with nested invalid AGENTS.md exits 2', () => {
    const subDir = path.join(gitRepo, 'lib');
    fs.mkdirSync(subDir, { recursive: true });
    const agentsFile = path.join(subDir, 'AGENTS.md');
    fs.writeFileSync(agentsFile, `---\nscope: "lib"\n---\n`);
    spawnSync('git', ['add', path.join('lib', 'AGENTS.md')], { cwd: gitRepo });
    const r = runCommitGate('git commit -m "add lib docs"', gitRepo);
    expect(r.status).toBe(2);
    // Should name the violated rules
    expect(r.stderr).toContain('last_updated_by');
    spawnSync('git', ['reset', 'HEAD', path.join('lib', 'AGENTS.md')], { cwd: gitRepo });
    fs.unlinkSync(agentsFile);
    fs.rmdirSync(subDir);
  });

  test('git commit with --amend is treated as a commit', () => {
    const agentsFile = path.join(gitRepo, 'AGENTS.md');
    fs.writeFileSync(agentsFile, '# bad\n');
    spawnSync('git', ['add', 'AGENTS.md'], { cwd: gitRepo });
    const r = runCommitGate('git commit --amend -m "fix"', gitRepo);
    expect(r.status).toBe(2);
    spawnSync('git', ['reset', 'HEAD', 'AGENTS.md'], { cwd: gitRepo });
    fs.unlinkSync(agentsFile);
  });
});
