import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create a temp root for synthetic skill sources and the fake workspace.
// fs.mkdtempSync ensures each test run gets a clean isolated directory.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'summon-skill-expand-'));

// --- Synthetic skill source directories ---

const sourceDir = path.join(tmpRoot, 'source-skills');

// Skill with a shell expression in SKILL.md — wiring must expand it.
const expandableSkillSrc = path.join(sourceDir, 'expandable-skill');
fs.mkdirSync(expandableSkillSrc, { recursive: true });
fs.writeFileSync(path.join(expandableSkillSrc, 'SKILL.md'), '$(echo injected)');

// Skill with no shell expressions — symlink must be left intact.
const plainSkillSrc = path.join(sourceDir, 'plain-skill');
fs.mkdirSync(plainSkillSrc, { recursive: true });
fs.writeFileSync(path.join(plainSkillSrc, 'SKILL.md'), 'plain content');

// --- Fake workspace with skill symlinks ---
// This mirrors what provisionOne currently produces: each skill dir in
// workspace/.claude/skills/ is a symlink to the canonical source.

const workspace = path.join(tmpRoot, 'workspace');
const workspaceSkillsDir = path.join(workspace, '.claude', 'skills');
fs.mkdirSync(workspaceSkillsDir, { recursive: true });

const expandableLink = path.join(workspaceSkillsDir, 'expandable-skill');
const plainLink = path.join(workspaceSkillsDir, 'plain-skill');
fs.symlinkSync(expandableSkillSrc, expandableLink, 'dir');
fs.symlinkSync(plainSkillSrc, plainLink, 'dir');

// Expansion wiring (pattern 4.2) is NOT yet implemented.
// The assertions below describe the required POST-expansion state.
// They fail (RED) until the wiring is added to provisionOne.

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

// (1) After expansion the skill dir with $(...) must be materialized — the
//     symlink replaced by a real directory — so SKILL.md is a plain regular
//     file at a stable workspace path, not a file visible only via indirection.
test('expandable skill SKILL.md is a regular file (not a symlink) after expansion', () => {
  const skillMdPath = path.join(workspaceSkillsDir, 'expandable-skill', 'SKILL.md');
  expect(fs.lstatSync(skillMdPath).isSymbolicLink()).toBe(false);
});

// (2) Expansion must have evaluated the shell expression: the file should
//     contain the output ("injected") and must NOT contain the raw literal.
//     Before wiring: content is still "$(echo injected)" → not.toContain fails → RED.
test('expandable SKILL.md contains expanded output and not the raw $(...) expression', () => {
  const content = fs.readFileSync(
    path.join(workspaceSkillsDir, 'expandable-skill', 'SKILL.md'),
    'utf8'
  );
  expect(content).toContain('injected');
  expect(content).not.toContain('$(echo injected)');
});

// (3) Skills whose SKILL.md has no $(...) must be left as symlinks — no
//     unnecessary copying. This assertion is GREEN both before and after wiring.
test('plain skill dir remains a symlink when SKILL.md has no shell expressions', () => {
  expect(fs.lstatSync(plainLink).isSymbolicLink()).toBe(true);
});
