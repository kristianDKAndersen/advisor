#!/usr/bin/env bash
# worker-inbox-poll.sh — PostToolUse hook: poll INBOX for new messages.
# Env vars consumed: ADV, INBOX, ADVISOR_WORKER_HOOKS
# State: $(dirname "$INBOX")/hook-last-seq (plain text, last read seq)
set -euo pipefail

[[ "${ADVISOR_WORKER_HOOKS:-}" == "0" ]] && exit 0
[[ -z "${INBOX:-}" || -z "${ADV:-}" ]] && exit 0

SEQ_FILE="$(dirname "$INBOX")/hook-last-seq"
LAST_SEQ=0
if [[ -f "$SEQ_FILE" ]]; then
  LAST_SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
fi

MSGS=$(bun "$ADV/lib/channel.js" recv --file "$INBOX" --after "$LAST_SEQ" --json 2>/dev/null || echo '[]')

# Single node spawn: parse MSGS once and emit three RS-delimited fields:
#   {newSeq}\x1e{terminate}\x1e{guidance}\x1e
# The trailing \x1e sentinel stops $() from stripping meaningful trailing newlines.
_RS=$'\x1e'
_PARSED=$(printf '%s' "$MSGS" | LAST_SEQ="$LAST_SEQ" node -e "
  const msgs = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const cur = parseInt(process.env.LAST_SEQ, 10) || 0;
  const newSeq = msgs.length ? Math.max(cur, ...msgs.map(m => m.seq || 0)) : cur;
  const terminate = msgs.some(m => m.type === 'terminate') ? '1' : '';
  const guidance = msgs.filter(m => m.type === 'guidance').map(m => m.body).join('\n');
  process.stdout.write(newSeq + '\x1e' + terminate + '\x1e' + guidance + '\x1e');
" 2>/dev/null || printf '%s\x1e\x1e\x1e' "$LAST_SEQ")

# Extract fields with bash parameter expansion — no additional process spawns.
NEW_SEQ="${_PARSED%%${_RS}*}"
_REST="${_PARSED#*${_RS}}"
TERMINATE="${_REST%%${_RS}*}"
GUIDANCE="${_REST#*${_RS}}"
GUIDANCE="${GUIDANCE%${_RS}}"

[[ -z "$NEW_SEQ" ]] && NEW_SEQ="$LAST_SEQ"

echo "$NEW_SEQ" > "$SEQ_FILE"

# Heartbeat — fail-open: never blocks or fails the inbox poll above.
{
  _HB_DIR="$(dirname "$INBOX")"
  _HB_COUNTER="$_HB_DIR/hook-tool-count"
  _HB_FILE="$_HB_DIR/heartbeat.jsonl"
  _HB_COUNT=0
  [[ -f "$_HB_COUNTER" ]] && _HB_COUNT=$(cat "$_HB_COUNTER" 2>/dev/null || echo 0)
  _HB_COUNT=$((_HB_COUNT + 1))
  echo "$_HB_COUNT" > "$_HB_COUNTER"
  _HB_TS=$(node -e "process.stdout.write(String(Date.now()/1000))" 2>/dev/null || echo 0)
  printf '{"ts": %s, "tool_count": %d}\n' "$_HB_TS" "$_HB_COUNT" >> "$_HB_FILE"
} 2>/dev/null || true

if [[ -n "$GUIDANCE" ]]; then
  echo "[advisor-guidance] $GUIDANCE" >&2
fi

if [[ "$TERMINATE" == "1" ]]; then
  bash "$ADV/bin/close-tab"
fi
