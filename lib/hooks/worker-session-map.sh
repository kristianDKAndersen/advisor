#!/usr/bin/env bash
# SessionStart hook: record claude session UUID → advisor run SID mapping.
# Appends one JSON line to ~/.advisor/state/session-map.jsonl.
# Fail-open: any error exits 0 to avoid blocking worker startup.
[ -z "$ADVISOR_SID" ] && exit 0
STATE_DIR="${HOME:-/tmp}/.advisor/state"
mkdir -p "$STATE_DIR" 2>/dev/null || true
ENTRY="{\"run_sid\":\"$ADVISOR_SID\",\"claude_uuid\":\"$CLAUDE_CODE_SESSION_ID\",\"agent\":\"$ADVISOR_AGENT\"}"
echo "$ENTRY" >> "$STATE_DIR/session-map.jsonl" 2>/dev/null || true
exit 0
