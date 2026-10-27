#!/usr/bin/env bash
# worker-auto-close.sh — PostToolUse hook: close tab after result is sent.
# Reads stdin JSON: { tool_name, tool_input: { command }, tool_response: { output } }
# Env vars consumed: ADV, OUTBOX, ADVISOR_WORKER_HOOKS
set -euo pipefail

[[ "${ADVISOR_WORKER_HOOKS:-}" == "0" ]] && exit 0
[[ -z "${ADV:-}" ]] && exit 0

# Close only after a real successful result send; matching rule is in worker-auto-close-match.js.
MATCHES=$(node "$(dirname "${BASH_SOURCE[0]}")/worker-auto-close-match.js" 2>/dev/null || true)

if [[ "$MATCHES" == "1" ]]; then
  # Brief sleep to let channel.js append fully flush before killing the process.
  # bin/close-tab owns the ancestor-walk-and-kill; no duplicate walk needed here.
  sleep 0.3
  bash "$ADV/bin/close-tab"
fi
