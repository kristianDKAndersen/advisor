// Test-harness preload (bunfig.toml [test].preload).
//
// Runs before any test module is imported. lib/tmux-runner.js auto-runs its
// orphan reapers at module load (reaperSweepOrphanSessions + reapStaleWorktrees)
// unless ADVISOR_NO_REAPER=1. reapStaleWorktrees is destructive against the real
// repo's ~361 ws/* worktrees, so importing tmux-runner.js during `bun test`
// must NOT trigger it. Default the opt-out on for the whole suite; individual
// tests still call the reaper functions directly with injected execFn seams.
if (process.env.ADVISOR_NO_REAPER == null || process.env.ADVISOR_NO_REAPER === '') {
  process.env.ADVISOR_NO_REAPER = '1';
}
