// loop-worktree — round-aware git worktree lifecycle for bin/advisor-loop.
//
// Unlike bin/tournament's createWorktrees/cleanupAllWorktrees (one worktree
// per strategy, deleted on every process exit), a loop retains a single
// worktree across all rounds and deletes it only once the loop reaches a
// terminal status. See advisor-loop-design.md §7 "Worktree policy across
// rounds" for the rationale.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const TERMINAL_STATUSES = new Set(['won', 'exhausted', 'escalated']);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Durable root for loop worktrees — the same ADVISOR_RUNS_ROOT-or-homedir
 * convention lib/session.js uses for run state, NOT os.tmpdir(): macOS
 * periodically purges os.tmpdir() contents, which silently emptied
 * in-progress loop worktrees while their round_state.json and git worktree
 * registration still pointed at them.
 */
function runsRoot() {
  return process.env.ADVISOR_RUNS_ROOT || path.join(os.homedir(), '.advisor', 'runs');
}

/**
 * True if `repoRoot`'s worktree list (the authoritative source, not just
 * directory presence on disk) already contains `wtPath`.
 */
function worktreeExists(repoRoot, wtPath) {
  let out;
  try {
    out = childProcess.execFileSync(
      'git',
      ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' },
    );
  } catch (_) {
    return false;
  }
  return out
    .split('\n\n')
    .some((block) => block.split('\n')[0] === `worktree ${wtPath}`);
}

/**
 * True if `wtPath` is actually present on disk and non-empty. A worktree
 * git still registers can nonetheless have had its contents purged (e.g. an
 * old worktree living under os.tmpdir()) — registration alone is not proof
 * the tree is usable.
 */
function isWorktreeUsable(wtPath) {
  try {
    return fs.readdirSync(wtPath).length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Round 0: creates a detached worktree at headSha (same git command shape as
 * bin/tournament:187-211's createWorktrees). Round 1+: pass the previously
 * returned `worktreePath` back in — it is returned unchanged, with no
 * `git worktree add` call and no reset of the working tree, so in-progress
 * (possibly uncommitted) round work survives into the next round.
 *
 * If `worktreePath` is still git-registered but missing or empty on disk
 * (purged out from under a still-registered path), the stale registration
 * is pruned and the worktree is recreated from `headSha` at the same path
 * instead of being handed back empty.
 */
function getOrCreateWorktree(repoRoot, { worktreePath, headSha, runId }) {
  if (worktreePath) {
    const registered = worktreeExists(repoRoot, worktreePath);
    if (registered && isWorktreeUsable(worktreePath)) {
      return { path: worktreePath, created: false };
    }
    if (registered) {
      // Stale registration: directory is gone or empty. Prune first so
      // `git worktree add` below doesn't fail on the already-registered path.
      try {
        childProcess.execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'ignore' });
      } catch (_) {
        // best-effort; `git worktree add` below will surface a real failure.
      }
    }
  }

  let wtPath = worktreePath;
  if (!wtPath) {
    const runDir = path.join(runsRoot(), runId);
    fs.mkdirSync(runDir, { recursive: true });
    wtPath = path.join(fs.realpathSync.native(runDir), 'worktree');
  }

  childProcess.execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'add', '--detach', wtPath, headSha],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return { path: wtPath, created: true };
}

/**
 * Files changed in the worktree relative to `baseSha` (the headSha the
 * worktree was created from), including files not yet tracked by git.
 * Stages everything first so newly-added files show up in `--cached` diff
 * output alongside modified ones.
 */
function filesChanged(worktreePath, baseSha) {
  childProcess.execFileSync('git', ['-C', worktreePath, 'add', '-A'], {
    stdio: 'ignore',
  });
  const out = childProcess.execFileSync(
    'git',
    ['-C', worktreePath, 'diff', '--name-only', '--cached', baseSha],
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

/**
 * Deletes the worktree only when `status` is loop-terminal (won, exhausted,
 * escalated). Returns whether a deletion happened. Non-terminal statuses are
 * a no-op — the worktree must survive for the next round to resume from.
 */
function removeWorktreeIfTerminal(repoRoot, worktreePath, status) {
  if (!isTerminalStatus(status)) return false;
  childProcess.execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath],
    { stdio: 'ignore' },
  );
  return true;
}

module.exports = {
  TERMINAL_STATUSES,
  isTerminalStatus,
  getOrCreateWorktree,
  filesChanged,
  removeWorktreeIfTerminal,
};
