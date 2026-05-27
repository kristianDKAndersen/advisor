#!/usr/bin/env bash
# poll-test.sh — manual test harness for worker-inbox-poll.sh parsing logic.
# Verifies 4 message scenarios: empty, terminate, guidance, mixed.
# Exit nonzero if any assertion fails.
#
# Run before and after editing worker-inbox-poll.sh to confirm behavior parity.

set -euo pipefail

PASS=0
FAIL=0

# Single-node parse snippet — must match the implementation in worker-inbox-poll.sh.
# Emits three fields separated by ASCII RS (0x1e) with a trailing RS sentinel:
#   {newSeq}\x1e{terminate}\x1e{guidance}\x1e
# The trailing RS prevents $() from stripping meaningful trailing newlines in guidance.
parse() {
  local msgs="$1" last_seq="$2"
  printf '%s' "$msgs" | LAST_SEQ="$last_seq" node -e "
    const msgs = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const cur = parseInt(process.env.LAST_SEQ, 10) || 0;
    const newSeq = msgs.length ? Math.max(cur, ...msgs.map(m => m.seq || 0)) : cur;
    const terminate = msgs.some(m => m.type === 'terminate') ? '1' : '';
    const guidance = msgs.filter(m => m.type === 'guidance').map(m => m.body).join('\n');
    process.stdout.write(newSeq + '\x1e' + terminate + '\x1e' + guidance + '\x1e');
  "
}

# Bash parameter-expansion extractors matching worker-inbox-poll.sh.
RS=$'\x1e'
extract_new_seq()  { local p="$1"; printf '%s' "${p%%${RS}*}"; }
extract_terminate() {
  local p="$1"
  local r="${p#*${RS}}"
  printf '%s' "${r%%${RS}*}"
}
extract_guidance() {
  local p="$1"
  local r="${p#*${RS}}"  # strip newSeq field
  local g="${r#*${RS}}"  # strip terminate field
  g="${g%${RS}}"         # strip trailing sentinel
  printf '%s' "$g"
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $(printf '%q' "$expected")"
    echo "    actual:   $(printf '%q' "$actual")"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Scenario 1: empty inbox ==="
P=$(parse '[]' 3)
check "newSeq stays at LAST_SEQ=3"  "3" "$(extract_new_seq "$P")"
check "terminate is empty"          ""  "$(extract_terminate "$P")"
check "guidance is empty"           ""  "$(extract_guidance "$P")"

echo ""
echo "=== Scenario 2: terminate message only ==="
P=$(parse '[{"seq":4,"type":"terminate","body":"stop","from":"advisor","ts":1}]' 3)
check "newSeq advances to 4" "4" "$(extract_new_seq "$P")"
check "terminate is 1"       "1" "$(extract_terminate "$P")"
check "guidance is empty"    ""  "$(extract_guidance "$P")"

echo ""
echo "=== Scenario 3: guidance message only ==="
P=$(parse '[{"seq":5,"type":"guidance","body":"adjust your approach","from":"advisor","ts":1}]' 3)
check "newSeq advances to 5"  "5"                    "$(extract_new_seq "$P")"
check "terminate is empty"    ""                     "$(extract_terminate "$P")"
check "guidance body present" "adjust your approach" "$(extract_guidance "$P")"

echo ""
echo "=== Scenario 4: mixed — guidance then terminate ==="
P=$(parse '[{"seq":6,"type":"guidance","body":"final note","from":"advisor","ts":1},{"seq":7,"type":"terminate","body":"done","from":"advisor","ts":1}]' 3)
check "newSeq advances to 7 (max)" "7"          "$(extract_new_seq "$P")"
check "terminate is 1"             "1"          "$(extract_terminate "$P")"
check "guidance body present"      "final note" "$(extract_guidance "$P")"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
