// TDD for the overlay collision guard in lib/summon.js (overlayAgentFiles).
//
// Bug: provisionCoderWorktree overlays spawns/<agent>/ onto a git worktree. On a
// case-INSENSITIVE filesystem, if the repo tracks a path under a DIFFERENT casing
// than one the overlay writes (e.g. tracked `claude.md` vs overlaid `CLAUDE.md`),
// the two are the SAME inode, so the overlay silently destroys the tracked file.
//
// The guard was originally a single special case for the root prompt, preserving
// it to <dest>/.advisor-root-prompt.md and returning { collision, preservedPath }.
// It is now GENERALIZED: every case-differing tracked file the overlay would
// displace is preserved to <dest>/.advisor-preserved/<tracked-relative-path>, and
// overlayAgentFiles returns { collision, preserved:[...] }. These tests were
// updated from the .advisor-root-prompt.md / preservedPath contract to the new
// .advisor-preserved / preserved-list contract for that reason.
//
// The rule is case-DIFFERENCE only: a tracked file in the EXACT casing the overlay
// writes (e.g. `.claude/settings.json`) is intended, pre-existing overwrite
// behaviour and is deliberately NOT preserved.

import { test, expect, afterEach } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { overlayAgentFiles, composeBootstrapPrompt } = require('../lib/summon');

const _created = [];
afterEach(() => {
  while (_created.length) {
    const d = _created.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

// Build a throwaway { repo, dest, agentSrc }: a git repo committing trackedFiles,
// a worktree of it at dest, and an agent source dir shipping agentFiles.
function scaffold(trackedFiles, agentFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summon-collision-'));
  _created.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  for (const [rel, content] of Object.entries(trackedFiles)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'seed');
  const dest = path.join(root, 'wt');
  g('worktree', 'add', '-q', '-b', 'ws-test', dest);
  const agentSrc = path.join(root, 'agent');
  fs.mkdirSync(agentSrc, { recursive: true });
  for (const [rel, content] of Object.entries(agentFiles)) {
    const abs = path.join(agentSrc, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, repo, dest, agentSrc };
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += String(chunk); return true; };
  try { const ret = fn(); return { ret, out }; }
  finally { process.stderr.write = orig; }
}

// REQUIREMENT — PROVABLE NO-OP. The repo tracks NO path that case-folds to any
// path the overlay writes: README.md plus two near-misses a correct full-path,
// case-folded compare must NOT match — docs/claude.md (same basename, different
// path) and claude.md.bak (superstring). Overlay must be byte-for-byte the
// original: a single untracked `?? CLAUDE.md`, nothing modified, NO
// .advisor-preserved directory, and the guard must report it did not fire. This
// is the load-bearing proof that every coder run in every other repo is inert.
test('no collision: overlay yields exactly one untracked CLAUDE.md, no .advisor-preserved, guard does not fire', () => {
  const { repo, dest, agentSrc } = scaffold(
    {
      'README.md': '# readme\n',
      'docs/claude.md': 'nested — different full path, must not match root fold\n',
      'claude.md.bak': 'backup — superstring, must not match root fold\n',
    },
    { 'CLAUDE.md': 'CODER ROLE PROMPT\n' }
  );
  const { ret } = captureStderr(() => overlayAgentFiles(agentSrc, dest, repo));
  const status = execFileSync('git', ['-C', dest, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  // Filesystem is unchanged vs a plain overlay: only the overlaid file, only untracked.
  expect(status).toBe('?? CLAUDE.md');
  // Did NOT fire: no preservation directory, no collision claim, empty list.
  expect(fs.existsSync(path.join(dest, '.advisor-preserved'))).toBe(false);
  expect(ret.collision).toBe(false);
  expect(ret.preserved).toEqual([]);
});

// REQUIREMENT — DETECTION (case-folded), PRESERVATION, WARNING. The repo tracks
// lowercase `claude.md`; the agent ships `CLAUDE.md`. `git ls-files` is
// case-sensitive, so only a case-FOLDED compare finds the collision. The repo's
// original content must be preserved to <dest>/.advisor-preserved/claude.md (the
// TRACKED casing) BEFORE the overlay runs, with a loud [summon] warning naming
// the colliding + preserved paths.
const ADVISOR_PROMPT = 'ADVISOR ROOT ORCHESTRATOR PROMPT — 47KB sentinel\n';
test('collision: tracked claude.md preserved to .advisor-preserved/claude.md before overlay, with a [summon] warning', () => {
  const { repo, dest, agentSrc } = scaffold(
    { 'claude.md': ADVISOR_PROMPT, 'README.md': '# r\n' },
    { 'CLAUDE.md': 'CODER ROLE PROMPT\n' }
  );
  const { ret, out } = captureStderr(() => overlayAgentFiles(agentSrc, dest, repo));
  // Preservation: the sibling holds the repo's ORIGINAL tracked content verbatim,
  // under the TRACKED casing (claude.md), not the overlay casing.
  const preserved = path.join(dest, '.advisor-preserved', 'claude.md');
  expect(fs.existsSync(preserved)).toBe(true);
  expect(fs.readFileSync(preserved, 'utf8')).toBe(ADVISOR_PROMPT);
  // Return contract: a list of entries, tracked casing reported.
  expect(ret.collision).toBe(true);
  expect(ret.preserved).toHaveLength(1);
  expect(ret.preserved[0].trackedPath).toBe('claude.md');
  expect(ret.preserved[0].overlayPath).toBe('CLAUDE.md');
  expect(ret.preserved[0].preservedPath).toBe(preserved);
  // Loud warning naming the colliding path and the preserved sibling.
  expect(out).toContain('[summon]');
  expect(out).toContain('claude.md');
  expect(out).toContain('.advisor-preserved');
});

// REQUIREMENT — NESTED collision exercises the recursive mkdir of the preserved
// parent directory. Repo tracks `docs/readme.md`; overlay ships `docs/README.md`
// (differs by case). Preserved to <dest>/.advisor-preserved/docs/readme.md.
test('collision: nested case-difference preserved under .advisor-preserved with created parent dirs', () => {
  const { repo, dest, agentSrc } = scaffold(
    { 'docs/readme.md': 'REPO NESTED ORIGINAL\n', 'README.md': '# r\n' },
    { 'docs/README.md': 'CODER NESTED OVERLAY\n' }
  );
  const { ret } = captureStderr(() => overlayAgentFiles(agentSrc, dest, repo));
  const preserved = path.join(dest, '.advisor-preserved', 'docs', 'readme.md');
  expect(fs.existsSync(preserved)).toBe(true);
  expect(fs.readFileSync(preserved, 'utf8')).toBe('REPO NESTED ORIGINAL\n');
  expect(ret.collision).toBe(true);
  expect(ret.preserved).toHaveLength(1);
  expect(ret.preserved[0].trackedPath).toBe('docs/readme.md');
});

// REQUIREMENT — EXACT casing is NOT preserved. The repo tracks
// `.claude/settings.json`; the overlay writes `.claude/settings.json` at the same
// exact path. This is intended, pre-existing overwrite behaviour (a repo shipping
// its own file) and MUST NOT trigger preservation, or we change behaviour for
// every repo that legitimately ships its own tracked file. No CLAUDE.md collision
// here (repo tracks no claude.md), so the whole overlay must be inert.
test('exact casing: a same-casing tracked file the overlay writes is NOT preserved', () => {
  const { repo, dest, agentSrc } = scaffold(
    { '.claude/settings.json': 'REPO SETTINGS\n', 'README.md': '# r\n' },
    { 'CLAUDE.md': 'ROLE\n', '.claude/settings.json': 'CODER SETTINGS\n' }
  );
  const { ret } = captureStderr(() => overlayAgentFiles(agentSrc, dest, repo));
  // Nothing preserved: no .advisor-preserved dir, empty list, no collision claim.
  expect(fs.existsSync(path.join(dest, '.advisor-preserved'))).toBe(false);
  expect(ret.collision).toBe(false);
  expect(ret.preserved).toEqual([]);
  // Pre-existing behaviour is unchanged: the overlay's settings won.
  expect(fs.readFileSync(path.join(dest, '.claude/settings.json'), 'utf8')).toBe('CODER SETTINGS\n');
});

// REQUIREMENT — a FAILED preservation must warn on stderr and NOT claim the
// collision was handled. Force the mkdir to fail by pre-creating
// <dest>/.advisor-preserved as a FILE, then trigger a genuine case collision.
test('failed preservation: warns on stderr and does not claim the collision was handled', () => {
  const { repo, dest, agentSrc } = scaffold(
    { 'claude.md': ADVISOR_PROMPT, 'README.md': '# r\n' },
    { 'CLAUDE.md': 'CODER ROLE PROMPT\n' }
  );
  // Block the preservation: .advisor-preserved is a file, so mkdir of the parent throws.
  fs.writeFileSync(path.join(dest, '.advisor-preserved'), 'blocker\n');
  const { ret, out } = captureStderr(() => overlayAgentFiles(agentSrc, dest, repo));
  expect(out).toContain('[summon] warn: could not preserve');
  expect(out).toContain('claude.md');
  // Failure must not be reported as a handled collision.
  expect(ret.collision).toBe(false);
  expect(ret.preserved).toEqual([]);
});

// REQUIREMENT — composeBootstrapPrompt is BYTE-IDENTICAL when no preservation
// occurred (flag absent vs flag explicitly false), so the prompt-cache prefix is
// unchanged. Also assert the no-preservation output carries no preservation note,
// and the preservation output names the .advisor-preserved directory.
test('composeBootstrapPrompt: byte-identical with flag absent vs false, note only when preserved', () => {
  const base = { agentName: 'coder', subTeam: false, subTeamModel: 'sonnet' };
  const absent = composeBootstrapPrompt({ ...base });
  const explicitFalse = composeBootstrapPrompt({ ...base, rootPromptCollision: false });
  expect(absent).toBe(explicitFalse);
  // The no-preservation prefix must not mention the preservation mechanism at all.
  expect(absent).not.toContain('.advisor-preserved');
  expect(absent).not.toContain('NOTE:');
  // With a preservation, the note names the .advisor-preserved directory.
  const withCollision = composeBootstrapPrompt({ ...base, rootPromptCollision: true });
  expect(withCollision).toContain('.advisor-preserved');
  expect(withCollision).not.toBe(absent);
});
