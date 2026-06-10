#!/usr/bin/env bash
# _worktree-capture.sh — sourced library exposing _capture_worktree.
#
# Approach A (capture-before-remove): snapshot a coder worktree's changed +
# untracked file set into $OUTPUT_DIR before the worktree is force-removed, so
# uncommitted/untracked coder output survives teardown. Used by both
# bin/close-worker-tab (synthesize-driven teardown) and lib/tmux-runner.js's
# orphan reaper (reapStaleWorktrees).
#
# Usage (sourced):  _capture_worktree <workspaceDir> <outputDir> <sid>
#
# Returns 0 on success OR a graceful no-op (the workspace is not a git worktree,
# e.g. a copyDir non-coder workspace — nothing to capture). Returns non-zero on
# capture failure and writes a CAPTURE_FAILED marker; callers must then skip
# `git worktree remove` so un-captured work is never destroyed, unless the
# operator escape hatch ADVISOR_FORCE_REMOVE_UNCAPTURED=1 is set.

_capture_worktree() {
  local workspaceDir="$1" outputDir="$2" sid="$3"

  # Graceful no-op: not a git worktree. Do not create any capture artifacts.
  if ! git -C "$workspaceDir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  local captureDir="$outputDir/worktree-capture"
  local filesDir="$captureDir/files"

  # Step 1: create the capture target. If the output sink itself is unwritable,
  # fail closed (best-effort marker in outputDir if it is writable at all).
  if ! mkdir -p "$filesDir" 2>/dev/null; then
    mkdir -p "$outputDir" 2>/dev/null && : > "$outputDir/CAPTURE_FAILED" 2>/dev/null
    return 1
  fi

  local rc=0

  # Step 2: stage everything (tracked + untracked, minus gitignored). After this
  # formerly-untracked files appear in `diff --cached`.
  git -C "$workspaceDir" add -A 2>/dev/null || rc=1

  # Step 3: binary patch of the staged delta (captures content diffs incl. binary).
  git -C "$workspaceDir" diff --cached --binary > "$captureDir/worktree.patch" 2>/dev/null || rc=1

  # Step 4: materialize the changed file set so brand-new files round-trip even
  # with no patch base. NUL-delimited names → safe for spaces/newlines in paths.
  local fileCount=0 byteTotal=0 rel src dest sz
  while IFS= read -r -d '' rel; do
    [[ -z "$rel" ]] && continue
    src="$workspaceDir/$rel"
    # -e is false for a dangling symlink; -L catches symlinks regardless of
    # whether their target exists, so they round-trip as symlinks (see cp -a).
    [[ -e "$src" || -L "$src" ]] || continue   # skip deletions (captured in worktree.patch)
    dest="$filesDir/$rel"
    if ! mkdir -p "$(dirname "$dest")" 2>/dev/null; then rc=1; break; fi
    # cp -a copies a symlink AS a symlink and recurses real dirs; portable on
    # macOS(BSD)+Linux. Bare `cp` would dereference a skill symlink-to-dir and
    # fail with "is a directory" on every real worktree (BSD `cp -P` is unreliable).
    if ! cp -a "$src" "$dest" 2>/dev/null; then rc=1; break; fi
    fileCount=$((fileCount + 1))
    sz=$(wc -c < "$src" 2>/dev/null | tr -d '[:space:]')
    [[ -n "$sz" ]] && byteTotal=$((byteTotal + sz))
  done < <( { git -C "$workspaceDir" diff --cached --name-only -z 2>/dev/null;
              git -C "$workspaceDir" ls-files --others --exclude-standard -z 2>/dev/null; } )

  # Step 5: manifest for verifiability.
  local branch ts
  branch="$(git -C "$workspaceDir" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  ts="$(date +%s 2>/dev/null)"
  printf '{"sid":"%s","branch":"%s","files":%d,"bytes":%d,"timestamp":%s}\n' \
    "$sid" "$branch" "$fileCount" "$byteTotal" "${ts:-0}" \
    > "$captureDir/MANIFEST.json" 2>/dev/null || rc=1

  # Step 6: fail closed.
  if [[ $rc -ne 0 ]]; then
    : > "$captureDir/CAPTURE_FAILED" 2>/dev/null || true
    return 1
  fi
  return 0
}
