// TDD for the overlay collision guard in lib/summon.js (overlayAgentFiles).
//
// Bug: provisionCoderWorktree overlays spawns/<agent>/CLAUDE.md onto a git
// worktree. On a case-INSENSITIVE filesystem, if the target repo tracks its own
// root prompt as `claude.md`, <worktree>/CLAUDE.md and <worktree>/claude.md are
// the SAME inode, so the overlay silently destroys the tracked prompt.
//
// These tests drive overlayAgentFiles(agentSrc, dest, repo) directly against
// throwaway git repos under os.tmpdir():
//   - collision path:    repo tracks `claude.md` -> original preserved + warned.
//   - no-collision path:  repo tracks no root prompt -> overlay is byte-for-byte
//     the original localCopyDir (untracked `?? CLAUDE.md`, nothing modified, no
//     preservation file, collision:false). This is the load-bearing no-op proof.

import { test, expect, afterEach } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { overlayAgentFiles } = require('../lib/summon');

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

// REQUIREMENT 2 — PROVABLE NO-OP. The repo tracks NO path that case-folds to
// `claude.md`: README.md plus two near-misses that a correct full-path,
// case-folded compare must NOT match — docs/claude.md (same basename, different
// path) and claude.md.bak (superstring). Overlay must be byte-for-byte the
// original: a single untracked `?? CLAUDE.md`, nothing modified, no marker file,
// and the guard must report it did not fire.
test('no collision: overlay yields exactly one untracked CLAUDE.md and the guard does not fire', () => {
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
  // Filesystem is unchanged vs today: only the overlaid file, only untracked.
  expect(status).toBe('?? CLAUDE.md');
  // Our branch did NOT fire: no preservation artifact, no collision claim.
  expect(fs.existsSync(path.join(dest, '.advisor-root-prompt.md'))).toBe(false);
  expect(ret.collision).toBe(false);
  expect(ret.preservedPath).toBe(null);
});

// REQUIREMENT 1/3/4 — DETECTION (case-folded), PRESERVATION, WARNING. The repo
// tracks lowercase `claude.md`; the agent ships `CLAUDE.md`. `git ls-files` is
// case-sensitive, so only a case-FOLDED compare finds the collision. The repo's
// original content must be preserved to <dest>/.advisor-root-prompt.md BEFORE the
// overlay runs, with a loud [summon] warning naming the colliding + preserved
// paths.
const ADVISOR_PROMPT = 'ADVISOR ROOT ORCHESTRATOR PROMPT — 47KB sentinel\n';
test('collision: tracked claude.md preserved to .advisor-root-prompt.md before overlay, with a [summon] warning', () => {
  const { repo, dest, agentSrc } = scaffold(
    { 'claude.md': ADVISOR_PROMPT, 'README.md': '# r\n' },
    { 'CLAUDE.md': 'CODER ROLE PROMPT\n' }
  );
  const { ret, out } = captureStderr(() => overlayAgentFiles(agentSrc, dest, repo));
  // Preservation: the sibling holds the repo's ORIGINAL tracked content verbatim.
  const preserved = path.join(dest, '.advisor-root-prompt.md');
  expect(fs.existsSync(preserved)).toBe(true);
  expect(fs.readFileSync(preserved, 'utf8')).toBe(ADVISOR_PROMPT);
  // Return contract.
  expect(ret.collision).toBe(true);
  expect(ret.preservedPath).toBe(preserved);
  // Loud warning naming the colliding path and the preserved sibling.
  expect(out).toContain('[summon]');
  expect(out).toContain('claude.md');
  expect(out).toContain('.advisor-root-prompt.md');
});
