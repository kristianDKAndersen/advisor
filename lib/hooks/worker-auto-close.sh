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
  # Brief sleep to let channel.js append fully flush before killing the process.
  # bin/close-tab owns the ancestor-walk-and-kill; no duplicate walk needed here.
  sleep 0.3
  bash "$ADV/bin/close-tab"
fi
