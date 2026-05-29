#!/usr/bin/env bash
set -euo pipefail

SID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sid) SID="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SID" ]]; then
  echo "Usage: diagnose.sh --sid <session-id>" >&2
  exit 1
fi

RUNS_ROOT="${ADVISOR_RUNS_ROOT:-$HOME/.advisor/runs}"
RUN_DIR="$RUNS_ROOT/$SID"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "Session directory not found: $RUN_DIR" >&2
  exit 1
fi

echo "# Advisor Session Diagnosis: $SID"
echo ""

# --- session.json -------------------------------------------------------
SESSION_JSON="$RUN_DIR/session.json"
echo "## session.json"
if [[ -f "$SESSION_JSON" ]]; then
  MTIME=$(date -r "$SESSION_JSON" '+%Y-%m-%d %H:%M:%S' 2>/dev/null \
    || stat -c '%y' "$SESSION_JSON" 2>/dev/null \
    || echo "unknown")
  echo "- mtime: $MTIME"
  jq -r '
    "- next_action: " + (.next_action // "(none)"),
    if (.decomposition | type) == "array" then
      "- decomposition:",
      (.decomposition[] | "  - " + .id + ": " + (.status // "unknown"))
    else
      "- decomposition: (none)"
    end
  ' "$SESSION_JSON" 2>/dev/null || echo "  (session.json parse error)" >&2
else
  echo "  (not found)" >&2
fi
echo ""

# --- Outbox tail --------------------------------------------------------
OUTBOX="$RUN_DIR/channel/outbox.jsonl"
echo "## Outbox (last 5 messages)"
if [[ -f "$OUTBOX" ]]; then
  while IFS= read -r line; do
    TYPE=$(printf '%s' "$line" | jq -r '.type // "unknown"' 2>/dev/null || echo "unknown")
    SEQ=$(printf '%s'  "$line" | jq -r '.seq  // "?"'      2>/dev/null || echo "?")
    FROM=$(printf '%s' "$line" | jq -r '.from // "?"'      2>/dev/null || echo "?")
    echo "- [$SEQ] type=$TYPE from=$FROM"
  done < <(tail -n 5 "$OUTBOX")
else
  echo "  (not found)" >&2
fi
echo ""

# --- Process state ------------------------------------------------------
# SID is interpolated as a literal (grep -F, ps+grep pipeline) so a SID
# containing regex metacharacters cannot corrupt the count.
echo "## Process State"
TMUX_COUNT=0
if command -v tmux >/dev/null 2>&1; then
  if [[ "${ADVISOR_TMUX_MULTIPLEX:-}" == "1" ]]; then
    TMUX_COUNT=$(tmux list-windows -t advisor -F '#{window_name}' 2>/dev/null \
      | grep -Fc "$SID" || echo 0)
    echo "- advisor session windows matching sid: $TMUX_COUNT"
  else
    TMUX_COUNT=$(tmux ls 2>/dev/null | grep -Fc "advisor-${SID}" || echo 0)
    echo "- tmux sessions matching pattern: $TMUX_COUNT"
  fi
else
  echo "- tmux sessions matching pattern: $TMUX_COUNT"
fi

PROC_COUNT=$(ps -eo pid,args 2>/dev/null | grep -F -- "$SID" | grep -v grep | wc -l | tr -d ' ' || echo 0)
echo "- processes matching sid: $PROC_COUNT"
echo ""

# --- Sentinel files -----------------------------------------------------
echo "## Sentinel Files"
SENTINEL_COUNT=$(find /tmp -maxdepth 1 -name "claude-i-*.done" 2>/dev/null \
  | grep -Fc "$SID" || echo 0)
echo "- /tmp/claude-i-*.done matching sid: $SENTINEL_COUNT"

TTY_FILE="$RUN_DIR/tty.txt"
if [[ -f "$TTY_FILE" ]]; then
  echo "- tty.txt: present ($(cat "$TTY_FILE"))"
else
  echo "- tty.txt: absent"
fi
