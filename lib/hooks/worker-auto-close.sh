#!/usr/bin/env bash
# worker-auto-close.sh — PostToolUse hook: close tab after result is sent.
# Reads stdin JSON: { tool_name, tool_input: { command }, tool_response: { output } }
# Env vars consumed: ADV, OUTBOX, ADVISOR_WORKER_HOOKS
set -euo pipefail

[[ "${ADVISOR_WORKER_HOOKS:-}" == "0" ]] && exit 0
[[ -z "${ADV:-}" ]] && exit 0

INPUT=$(cat)

MATCHES=$(echo "$INPUT" | node -e "
  const data = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const cmd = (data.tool_input && data.tool_input.command) || '';
  // Must be a channel.js send with --type result to the outbox (not a different file)
  const isResult = cmd.includes('channel.js') &&
    /--type\s+result/.test(cmd) &&
    !cmd.includes('--type result-check') &&
    (cmd.includes('OUTBOX') || cmd.includes('outbox.jsonl'));
  process.stdout.write(isResult ? '1' : '');
" 2>/dev/null || true)

if [[ "$MATCHES" == "1" ]]; then
  # Brief sleep to let channel.js append fully flush before killing the process
  sleep 0.3
  # Walk the ancestor chain from $PPID looking for the claude process.
  # The hook is invoked by claude directly, so $PPID is typically claude,
  # but we traverse up to 3 levels to handle shell-wrapper intermediaries.
  _pid=$PPID
  _claude_pid=""
  for _i in 1 2 3; do
    _comm=$(ps -o comm= -p "$_pid" 2>/dev/null | awk -F'/' '{print $NF}' | tr -d ' ')
    if [[ "$_comm" == "claude" ]]; then
      _claude_pid="$_pid"
      break
    fi
    _next=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
    [[ -z "$_next" || "$_next" == "0" || "$_next" == "$_pid" ]] && break
    _pid="$_next"
  done
  if [[ -n "$_claude_pid" ]]; then
    kill -TERM "$_claude_pid" 2>/dev/null || true
  fi
  bash "$ADV/bin/close-tab"
fi
