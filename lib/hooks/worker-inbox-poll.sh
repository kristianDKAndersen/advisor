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

NEW_SEQ=$(echo "$MSGS" | LAST_SEQ="$LAST_SEQ" node -e "
  const msgs = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const cur = parseInt(process.env.LAST_SEQ, 10) || 0;
  if (!msgs.length) { process.stdout.write(String(cur)); process.exit(0); }
  const maxSeq = Math.max(...msgs.map(m => m.seq || 0));
  process.stdout.write(String(Math.max(cur, maxSeq)));
" 2>/dev/null || echo "$LAST_SEQ")

echo "$NEW_SEQ" > "$SEQ_FILE"

TERMINATE=$(echo "$MSGS" | node -e "
  const msgs = JSON.parse(require('fs').readFileSync(0,'utf8'));
  if (msgs.some(m => m.type === 'terminate')) process.stdout.write('1');
" 2>/dev/null || true)

GUIDANCE=$(echo "$MSGS" | node -e "
  const msgs = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const g = msgs.filter(m => m.type === 'guidance').map(m => m.body).join('\n');
  if (g) process.stdout.write(g);
" 2>/dev/null || true)

if [[ -n "$GUIDANCE" ]]; then
  echo "[advisor-guidance] $GUIDANCE" >&2
fi

if [[ "$TERMINATE" == "1" ]]; then
  bash "$ADV/bin/close-tab"
fi
