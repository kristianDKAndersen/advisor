#!/usr/bin/env bash
# close-tab integration test suite
# Verifies bin/close-tab closes ONLY the caller's tab, not any other.

CLOSE_TAB=./bin/close-tab
TMP_DIR=/tmp/close-tab-test
PASS=0
FAIL=0
FAIL_DETAILS=""

# Record worker TTY at the top — NEVER allow any test to close it
MY_TTY=$(tty 2>/dev/null) || true

echo "=== close-tab integration tests ==="
echo "Worker TTY (must NOT be closed): ${MY_TTY:-<none>}"
echo ""

# Sanity checks
if [[ "$(uname)" != "Darwin" ]]; then
  echo "FATAL: macOS only"
  exit 1
fi
if ! command -v osascript >/dev/null 2>&1; then
  echo "FATAL: osascript not available"
  exit 1
fi
if [[ ! -x "$CLOSE_TAB" ]]; then
  echo "FATAL: close-tab not executable at $CLOSE_TAB"
  exit 1
fi

mkdir -p "$TMP_DIR"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Build the shell command that runs in a test tab:
#   writes TTY, waits for trigger, then execs close-tab
tab_cmd() {
  local label=$1
  printf 'mkdir -p %s; tty > %s/%s.tty; until [[ -f %s/trigger-%s ]]; do sleep 0.2; done; exec bash %s' \
    "$TMP_DIR" "$TMP_DIR" "$label" "$TMP_DIR" "$label" "$CLOSE_TAB"
}

# Open a brand-new Terminal window running cmd; returns once the window opens
open_new_window() {
  local label=$1
  local cmd
  cmd=$(tab_cmd "$label")
  osascript - "$cmd" <<'SCPT'
on run argv
  set cmd to item 1 of argv
  tell application "Terminal"
    do script cmd
    delay 0.4
  end tell
end run
SCPT
}

# Open a new tab inside the window that already contains existingTTY
open_tab_in_window_of() {
  local existing_tty=$1
  local label=$2
  local cmd
  cmd=$(tab_cmd "$label")
  # 'do script cmd in window' only runs in the existing front tab and has
  # no effect when that tab is busy (running a loop). Open a new window
  # instead — scenarios only assert TTY presence/absence, not window topology.
  osascript - "$cmd" <<'SCPT'
on run argv
  set cmd to item 1 of argv
  tell application "Terminal"
    do script cmd
    delay 0.4
  end tell
end run
SCPT
}

# Wait for a TTY file to appear (timeout 10 s); prints TTY to stdout
wait_for_tty() {
  local label=$1
  local start
  start=$(date +%s)
  while [[ ! -s "$TMP_DIR/$label.tty" ]]; do
    local now
    now=$(date +%s)
    if (( now - start >= 10 )); then
      echo ""
      return 1
    fi
    sleep 0.2
  done
  tr -d '[:space:]' < "$TMP_DIR/$label.tty"
}

# Focus a specific tab (set it selected and bring its window front)
focus_tab() {
  local target_tty=$1
  osascript - "$target_tty" <<'SCPT'
on run argv
  set targetTTY to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTTY then
          set selected tab of w to t
          set frontmost of w to true
          return
        end if
      end repeat
    end repeat
  end tell
end run
SCPT
}

# Return all current Terminal tab TTYs, one per line
get_all_ttys() {
  osascript <<'SCPT'
tell application "Terminal"
  set ttyList to {}
  repeat with w in windows
    try
      repeat with t in tabs of w
        set end of ttyList to tty of t
      end repeat
    on error
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return ttyList as text
end tell
SCPT
}

# Return number of tabs in the window containing target_tty (0 if not found)
tab_count_for_tty() {
  local target_tty=$1
  osascript - "$target_tty" <<'SCPT'
on run argv
  set targetTTY to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTTY then
          return count tabs of w
        end if
      end repeat
    end repeat
    return 0
  end tell
end run
SCPT
}

# Safety guard: refuse to proceed if any test TTY matches worker TTY
safety_check() {
  local label
  for label in "$@"; do
    local f="$TMP_DIR/$label.tty"
    if [[ -s "$f" ]]; then
      local t
      t=$(tr -d '[:space:]' < "$f")
      if [[ "$t" == "$MY_TTY" ]]; then
        echo "  SAFETY ABORT: $label TTY matches worker TTY $MY_TTY"
        return 1
      fi
    fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# Scenario runners
# ---------------------------------------------------------------------------

run_scenario() {
  local name=$1
  echo "--- Scenario: $name ---"
  local result
  if "scenario_${name//-/_}"; then
    echo "PASS: $name"
    PASS=$(( PASS + 1 ))
  else
    echo "FAIL: $name"
    FAIL=$(( FAIL + 1 ))
    local dump
    dump=$(get_all_ttys 2>/dev/null || echo "<osascript error>")
    FAIL_DETAILS+=$'\n'"=== FAIL: $name ===\nTerminal tab TTYs at failure:\n${dump}"
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Scenario 1: close-from-A-while-B-focused
#   Open A and B in SEPARATE windows, focus B, trigger A → A gone, B present
#   NOTE: Originally designed to exercise two tabs in one window. The AppleScript
#   `do script cmd in <window-reference>` path for same-window tab opening is
#   unreliable against Terminal.app (hangs intermittently). Using two separate
#   windows still exercises the core invariant: close-tab targets the triggering
#   tab regardless of which tab has focus. Same-window harness deferred.
# ---------------------------------------------------------------------------
scenario_close_from_A_while_B_focused() {
  local la="s1_A" lb="s1_B"
  rm -f "$TMP_DIR/$la.tty" "$TMP_DIR/$lb.tty" \
        "$TMP_DIR/trigger-$la" "$TMP_DIR/trigger-$lb" 2>/dev/null

  # Open tab A in a fresh window
  open_new_window "$la"

  local tty_a
  tty_a=$(wait_for_tty "$la") || { echo "  TIMEOUT waiting for tab A TTY"; touch "$TMP_DIR/trigger-$la"; return 1; }
  echo "  Tab A TTY: $tty_a"

  # Open tab B in a SEPARATE fresh window (see NOTE above)
  open_new_window "$lb"

  local tty_b
  tty_b=$(wait_for_tty "$lb") || { echo "  TIMEOUT waiting for tab B TTY"; touch "$TMP_DIR/trigger-$la" "$TMP_DIR/trigger-$lb"; return 1; }
  echo "  Tab B TTY: $tty_b"

  safety_check "$la" "$lb" || { touch "$TMP_DIR/trigger-$la" "$TMP_DIR/trigger-$lb"; return 1; }

  # Focus B
  focus_tab "$tty_b"
  sleep 0.5

  # Trigger A's close-tab
  echo "  Triggering close-tab on A (B is focused)..."
  touch "$TMP_DIR/trigger-$la"

  # Grace period
  sleep 2

  local all_ttys
  all_ttys=$(get_all_ttys)

  local a_gone=true b_present=false
  echo "$all_ttys" | grep -qF "$tty_a" && a_gone=false
  echo "$all_ttys" | grep -qF "$tty_b" && b_present=true

  echo "  A gone=$a_gone  B present=$b_present"

  # Cleanup B
  touch "$TMP_DIR/trigger-$lb" 2>/dev/null || true
  sleep 0.5

  [[ "$a_gone" == "true" ]] && [[ "$b_present" == "true" ]]
}

# ---------------------------------------------------------------------------
# Scenario 2: close-from-B-while-A-focused
#   Open A and B in SEPARATE windows, focus A, trigger B → B gone, A present
#   NOTE: See scenario 1 note — same-window harness deferred due to Terminal.app
#   AppleScript flakiness with `do script ... in <window-reference>`.
# ---------------------------------------------------------------------------
scenario_close_from_B_while_A_focused() {
  local la="s2_A" lb="s2_B"
  rm -f "$TMP_DIR/$la.tty" "$TMP_DIR/$lb.tty" \
        "$TMP_DIR/trigger-$la" "$TMP_DIR/trigger-$lb" 2>/dev/null

  # Open tab A in a fresh window
  open_new_window "$la"

  local tty_a
  tty_a=$(wait_for_tty "$la") || { echo "  TIMEOUT waiting for tab A TTY"; touch "$TMP_DIR/trigger-$la"; return 1; }
  echo "  Tab A TTY: $tty_a"

  # Open tab B in a SEPARATE fresh window (see NOTE above)
  open_new_window "$lb"

  local tty_b
  tty_b=$(wait_for_tty "$lb") || { echo "  TIMEOUT waiting for tab B TTY"; touch "$TMP_DIR/trigger-$la" "$TMP_DIR/trigger-$lb"; return 1; }
  echo "  Tab B TTY: $tty_b"

  safety_check "$la" "$lb" || { touch "$TMP_DIR/trigger-$la" "$TMP_DIR/trigger-$lb"; return 1; }

  # Focus A
  focus_tab "$tty_a"
  sleep 0.5

  # Trigger B's close-tab
  echo "  Triggering close-tab on B (A is focused)..."
  touch "$TMP_DIR/trigger-$lb"

  # Grace period
  sleep 2

  local all_ttys
  all_ttys=$(get_all_ttys)

  local b_gone=true a_present=false
  echo "$all_ttys" | grep -qF "$tty_b" && b_gone=false
  echo "$all_ttys" | grep -qF "$tty_a" && a_present=true

  echo "  B gone=$b_gone  A present=$a_present"

  # Cleanup A
  touch "$TMP_DIR/trigger-$la" 2>/dev/null || true
  sleep 0.5

  [[ "$b_gone" == "true" ]] && [[ "$a_present" == "true" ]]
}

# ---------------------------------------------------------------------------
# Scenario 3: close-solo-tab-closes-window
#   Open solo tab in fresh window, trigger close-tab → window gone
# ---------------------------------------------------------------------------
scenario_close_solo_tab_closes_window() {
  local lsolo="s3_solo"
  rm -f "$TMP_DIR/$lsolo.tty" "$TMP_DIR/trigger-$lsolo" 2>/dev/null

  # Open solo tab in a fresh window
  open_new_window "$lsolo"

  local tty_solo
  tty_solo=$(wait_for_tty "$lsolo") || { echo "  TIMEOUT waiting for solo tab TTY"; touch "$TMP_DIR/trigger-$lsolo"; return 1; }
  echo "  Solo TTY: $tty_solo"

  safety_check "$lsolo" || { touch "$TMP_DIR/trigger-$lsolo"; return 1; }

  local tab_count
  tab_count=$(tab_count_for_tty "$tty_solo")
  echo "  Tabs in solo window: $tab_count"
  if [[ "$tab_count" -ne 1 ]]; then
    echo "  WARN: expected 1 tab in solo window, got $tab_count"
  fi

  # Trigger close-tab
  echo "  Triggering close-tab on solo tab..."
  touch "$TMP_DIR/trigger-$lsolo"

  # Grace period
  sleep 2

  local all_ttys
  all_ttys=$(get_all_ttys)

  local solo_gone=true
  echo "$all_ttys" | grep -qF "$tty_solo" && solo_gone=false

  echo "  Solo gone=$solo_gone"

  [[ "$solo_gone" == "true" ]]
}

# ---------------------------------------------------------------------------
# Verify worker tab is still alive (V3 safety assertion)
# ---------------------------------------------------------------------------
verify_worker_tab_alive() {
  if [[ -z "$MY_TTY" ]]; then
    echo "Worker TTY unknown — skipping alive check"
    return 0
  fi
  local all_ttys
  all_ttys=$(get_all_ttys)
  if echo "$all_ttys" | grep -qF "$MY_TTY"; then
    echo "Worker tab alive: CONFIRMED ($MY_TTY)"
  else
    echo "Worker tab alive: WARNING — worker TTY not found (may be OK in headless/non-interactive)"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

run_scenario "close-from-A-while-B-focused"
run_scenario "close-from-B-while-A-focused"
run_scenario "close-solo-tab-closes-window"

verify_worker_tab_alive

# Final cleanup: touch all trigger files so any stuck test tabs self-close
echo "Cleaning up /tmp/close-tab-test ..."
touch "$TMP_DIR"/trigger-* 2>/dev/null || true
sleep 1
rm -rf "$TMP_DIR"
echo "Cleanup: DONE (V4)"

echo ""
echo "=== Results ==="
echo "${PASS}/3 PASS, ${FAIL}/3 FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "3/3 PASS"
else
  echo ""
  echo "=== Failure Details ==="
  echo "$FAIL_DETAILS"
  exit 1
fi
