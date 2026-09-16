// Isolation generalization: the git-worktree treatment must extend from the
// hardcoded single 'coder' agent to the shared WORKTREE_AGENTS set
// {coder, doc-agent, planner}, and teardown must remove those worktrees.
//
// Proves:
//  (a) doc-agent and planner each get a git worktree with $REPO === workspace.
//  (b) a non-set agent (researcher) still gets a copyDir with $REPO === repo.
//  (c) teardown removes a doc-agent worktree, leaving no .git/worktrees entry.
//  (d) the coder timeout bump applies to coder ONLY.
//
// provisionOne is exercised via a subprocess helper (mirrors
// summon-launch-stderr.test.js) so ADVISOR_RUNS_ROOT is honored at
// session.js module-load time. Teardown is exercised via `channel.js synthesize`
// as a subprocess (mirrors synthesize-worktree-cleanup.test.js).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_PATH = path.resolve(import.meta.dir, '../lib/summon.js');
const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');
const TEST_TIMEOUT = 30000;
const BIG_TASK = 'x'.repeat(2000); // len > 1500 → scaledCoderTimeout returns 2400

let tmpRuns;
let tmpRepo;

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wai-repo-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

// Run provisionOne for one agent in an isolated runs-root, cwd = a real git repo,
// and return the parsed result object (includes launchScript, workspace, repo,
// and timeoutSec when defined).
function provision(agent, { sid, task = 'test task' }) {
  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wai-helper-'));
  const helper = path.join(helperDir, 'provision.js');
  fs.writeFileSync(
    helper,
    `const summon = require(${JSON.stringify(SUMMON_PATH)});
const result = summon.provisionOne({
  agent: ${JSON.stringify(agent)},
  task: ${JSON.stringify(task)},
  goal: 'test goal',
  cwd: ${JSON.stringify(tmpRepo)},
  isTestSession: true,
}, ${JSON.stringify(sid)});
console.log(JSON.stringify(result));
`
  );
  const out = execFileSync('bun', [helper], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns },
  });
  fs.rmSync(helperDir, { recursive: true, force: true });
  return JSON.parse(out.trim().split('\n').pop());
}

// Extract the literal value of `export REPO=...` from a launch.sh file.
function repoEnv(launchScript) {
  const content = fs.readFileSync(launchScript, 'utf8');
  const m = content.match(/^export REPO=(.*)$/m);
  if (!m) throw new Error('no REPO export in launch.sh');
  let v = m[1].trim();
  if (v.startsWith("'") && v.endsWith("'")) {
    v = v.slice(1, -1).replace(/'\\''/g, "'");
  }
  return v;
}

beforeEach(() => {
  tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'wai-runs-'));
  tmpRepo = makeGitRepo();
});

afterEach(() => {
  try { execFileSync('git', ['-C', tmpRepo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch (_) {}
  if (tmpRuns) fs.rmSync(tmpRuns, { recursive: true, force: true });
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

// ── (a) doc-agent and planner get a worktree with $REPO === workspace ─────────
for (const agent of ['doc-agent', 'planner']) {
  test(`[WAI-a] ${agent} gets a git worktree with REPO === workspace`, { timeout: TEST_TIMEOUT }, () => {
    const sid = `wai-a-${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = provision(agent, { sid });
    // A git worktree has a .git FILE (gitdir pointer), not a directory.
    expect(fs.existsSync(path.join(r.workspace, '.git'))).toBe(true);
    // workerRepo === workspace: the worker edits inside the isolated worktree.
    expect(repoEnv(r.launchScript)).toBe(r.workspace);
    // The worktree must be registered against the origin repo.
    const wtList = execFileSync('git', ['-C', tmpRepo, 'worktree', 'list'], { encoding: 'utf8' });
    expect(wtList).toContain(sid);
  });
}

// ── (b) a non-set agent still gets copyDir with $REPO === repo ────────────────
test('[WAI-b] researcher gets a copyDir workspace with REPO === repo (not workspace)', { timeout: TEST_TIMEOUT }, () => {
  const sid = `wai-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = provision('researcher', { sid });
  // copyDir workspace is a plain directory — no .git worktree pointer.
  expect(fs.existsSync(path.join(r.workspace, '.git'))).toBe(false);
  const repoVal = repoEnv(r.launchScript);
  expect(repoVal).toBe(r.repo);
  expect(repoVal).not.toBe(r.workspace);
  const wtList = execFileSync('git', ['-C', tmpRepo, 'worktree', 'list'], { encoding: 'utf8' });
  expect(wtList).not.toContain(sid);
});

// ── (c) teardown removes a doc-agent worktree — no .git/worktrees entry left ──
test('[WAI-c] synthesize teardown removes a doc-agent worktree and branch', { timeout: TEST_TIMEOUT }, () => {
  const sid = `wai-c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branchName = `ws/${sid}`;
  const workspaceDir = path.join(tmpRuns, sid, 'workspace');
  execFileSync('git', ['-C', tmpRepo, 'worktree', 'add', '-b', branchName, workspaceDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runDir = path.join(tmpRuns, sid);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ agent: 'doc-agent', repo: tmpRepo }));

  const result = spawnSync(
    'bun',
    [CHANNEL_JS, 'synthesize', '--sid', sid, '--seq', '1',
      '--established', 'test task', '--gap', 'none', '--material', 'yes', '--next', 'proceed'],
    { encoding: 'utf8', timeout: 25000,
      env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns, ADVISOR_SKIP_TAB_CLOSE: '1' } }
  );
  expect(result.status).toBe(0);

  // Workspace dir gone.
  expect(fs.existsSync(workspaceDir)).toBe(false);
  // Branch deleted.
  const branchList = execFileSync('git', ['-C', tmpRepo, 'branch', '--list', branchName], { encoding: 'utf8' }).trim();
  expect(branchList).toBe('');
  // No lingering .git/worktrees registration for this sid.
  const wtList = execFileSync('git', ['-C', tmpRepo, 'worktree', 'list'], { encoding: 'utf8' });
  expect(wtList).not.toContain(sid);
});

// ── (d) the coder timeout bump applies to coder ONLY ──────────────────────────
test('[WAI-d] scaled timeout bump is coder-only (doc-agent/planner unaffected)', { timeout: TEST_TIMEOUT }, () => {
  const coder = provision('coder', { sid: `wai-d-coder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, task: BIG_TASK });
  expect(coder.timeoutSec).toBe(2400);
  for (const agent of ['doc-agent', 'planner']) {
    const r = provision(agent, { sid: `wai-d-${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, task: BIG_TASK });
    expect(r.timeoutSec).toBeUndefined();
  }
});
