#!/bin/bash
# Advisor Statusline - terminal UI dashboard for Claude Code
# Receives JSON session data on stdin

DATA=$(cat)

# Extract fields with safe defaults
AGENT=$(echo "$DATA" | jq -r '.agent.name // "Advisor"')
MODEL=$(echo "$DATA" | jq -r '.model.display_name // .model.id // "unknown"')
CTX_PCT=$(echo "$DATA" | jq -r '.context_window.used_percentage // 0')
CTX_USED=$(echo "$DATA" | jq -r '.context_window.used_tokens // empty')
CTX_TOTAL=$(echo "$DATA" | jq -r '.context_window.total_tokens // empty')
COST=$(echo "$DATA" | jq -r '.cost.total_cost_usd // 0')
DURATION_MS=$(echo "$DATA" | jq -r '.cost.total_duration_ms // 0')
LINES_ADD=$(echo "$DATA" | jq -r '.cost.total_lines_added // 0')
LINES_REM=$(echo "$DATA" | jq -r '.cost.total_lines_removed // 0')
RATE_5H=$(echo "$DATA" | jq -r '.rate_limits.five_hour.used_percentage // empty')
RATE_7D=$(echo "$DATA" | jq -r '.rate_limits.seven_day.used_percentage // empty')
PROJECT_PATH=$(echo "$DATA" | jq -r '.workspace.root_directory // empty')
BRANCH=$(echo "$DATA" | jq -r '.worktree.branch // empty')

# ── ANSI color definitions ──────────────────────────────────────────────────
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"

# 256-color palette
C_AGENT="\033[1;38;5;213m"    # Bold bright magenta — agent name
C_MODEL="\033[38;5;117m"      # Bright cyan — model
C_COST="\033[38;5;228m"       # Bright yellow — cost
C_DIM_WHITE="\033[2;37m"      # Dim white — duration
C_LINES_ADD="\033[38;5;114m"  # Green — lines added
C_LINES_REM="\033[38;5;203m"  # Red — lines removed
C_FRAME="\033[38;5;240m"      # Dim gray — borders and separators
C_BAR_GREEN="\033[38;5;114m"  # Progress bar low
C_BAR_YELLOW="\033[38;5;226m" # Progress bar mid
C_BAR_RED="\033[38;5;203m"    # Progress bar high
C_PROJECT="\033[38;5;180m"    # Warm tan — project name
C_BRANCH="\033[38;5;156m"     # Light green — branch

# ── Context bar color thresholds ────────────────────────────────────────────
CTX_INT=${CTX_PCT%.*}
CTX_INT=${CTX_INT:-0}

if [ "$(echo "$CTX_PCT > 85" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  CTX_COLOR="$C_BAR_RED"
elif [ "$(echo "$CTX_PCT > 60" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  CTX_COLOR="$C_BAR_YELLOW"
else
  CTX_COLOR="$C_BAR_GREEN"
fi

# ── Gradient progress bar (15 chars wide) ───────────────────────────────────
BAR_WIDTH=15
FULL_CELLS=$(( CTX_INT * BAR_WIDTH / 100 ))
REMAINDER=$(( (CTX_INT * BAR_WIDTH * 8 / 100) - (FULL_CELLS * 8) ))
EMPTY_CELLS=$(( BAR_WIDTH - FULL_CELLS ))

PARTIAL_CHARS=(" " "▏" "▎" "▍" "▌" "▋" "▊" "▉")

BAR="${CTX_COLOR}"
for ((i=0; i<FULL_CELLS; i++)); do BAR+="█"; done

if [ "$FULL_CELLS" -lt "$BAR_WIDTH" ] && [ "$REMAINDER" -gt 0 ]; then
  BAR+="${PARTIAL_CHARS[$REMAINDER]}"
  EMPTY_CELLS=$(( EMPTY_CELLS - 1 ))
fi

BAR+="${DIM}"
for ((i=0; i<EMPTY_CELLS; i++)); do BAR+="░"; done
BAR+="${RESET}"

# ── Token count formatting (e.g., "450k/1M") ───────────────────────────────
format_tokens() {
  local tokens="$1"
  if [ -z "$tokens" ] || [ "$tokens" = "null" ]; then
    echo ""
    return
  fi
  local t=${tokens%.*}
  if [ "$t" -ge 1000000 ]; then
    local m=$(( t / 100000 ))
    local whole=$(( m / 10 ))
    local frac=$(( m % 10 ))
    if [ "$frac" -eq 0 ]; then
      echo "${whole}M"
    else
      echo "${whole}.${frac}M"
    fi
  elif [ "$t" -ge 1000 ]; then
    echo "$(( t / 1000 ))k"
  else
    echo "${t}"
  fi
}

TOKEN_USED_FMT=$(format_tokens "$CTX_USED")
TOKEN_TOTAL_FMT=$(format_tokens "$CTX_TOTAL")

if [ -n "$TOKEN_USED_FMT" ] && [ -n "$TOKEN_TOTAL_FMT" ]; then
  CTX_LABEL="${TOKEN_USED_FMT}/${TOKEN_TOTAL_FMT}"
else
  CTX_LABEL="${CTX_INT}%"
fi

# ── Project name (basename of workspace root) ──────────────────────────────
PROJECT=""
if [ -n "$PROJECT_PATH" ] && [ "$PROJECT_PATH" != "null" ]; then
  PROJECT=$(basename "$PROJECT_PATH")
fi

# ── Duration formatting ──────────────────────────────────────────────────────
DURATION_SEC=$((${DURATION_MS%.*} / 1000))
HOURS=$((DURATION_SEC / 3600))
MINS=$(( (DURATION_SEC % 3600) / 60 ))
SECS=$((DURATION_SEC % 60))
if [ "$HOURS" -gt 0 ]; then
  DURATION_FMT=$(printf "%dh%02dm" "$HOURS" "$MINS")
else
  DURATION_FMT=$(printf "%dm%02ds" "$MINS" "$SECS")
fi

# ── Cost formatting ──────────────────────────────────────────────────────────
COST_FMT=$(printf '$%.2f' "$COST")

# ── Rate limit string ────────────────────────────────────────────────────────
RATE_STR=""
if [ -n "$RATE_5H" ]; then
  RATE_5H_INT=${RATE_5H%.*}
  if [ "$(echo "$RATE_5H > 80" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    R5_COLOR="$C_LINES_REM"
  elif [ "$(echo "$RATE_5H > 50" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    R5_COLOR="$C_BAR_YELLOW"
  else
    R5_COLOR="$C_LINES_ADD"
  fi
  RATE_STR="${R5_COLOR}5h:${RATE_5H_INT}%${RESET}"
  if [ -n "$RATE_7D" ]; then
    RATE_7D_INT=${RATE_7D%.*}
    RATE_STR="${RATE_STR} ${DIM}7d:${RATE_7D_INT}%${RESET}"
  fi
fi

# ── Build single content line ────────────────────────────────────────────────
SEP="${C_FRAME}│${RESET}"

COL_AGENT="${C_AGENT}🔬 ${AGENT}${RESET}"
COL_CTX="${BAR} ${CTX_COLOR}${CTX_LABEL}${RESET}"
COL_MODEL="${C_MODEL}🧠 ${MODEL}${RESET}"
COL_COST="${C_COST}💰 ${COST_FMT}${RESET}"
COL_DUR="${C_DIM_WHITE}⏱️  ${DURATION_FMT}${RESET}"
COL_LINES="${C_LINES_ADD}📝 +${LINES_ADD}${RESET}${C_FRAME}/${RESET}${C_LINES_REM}-${LINES_REM}${RESET}"

COL_CONTENT=" ${COL_AGENT}"

if [ -n "$PROJECT" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${C_PROJECT}📂 ${PROJECT}${RESET}"
fi

if [ -n "$BRANCH" ] && [ "$BRANCH" != "null" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${C_BRANCH}🌿 ${BRANCH}${RESET}"
fi

COL_CONTENT="${COL_CONTENT} ${SEP} ${COL_CTX} ${SEP} ${COL_MODEL} ${SEP} ${COL_COST} ${SEP} ${COL_DUR} ${SEP} ${COL_LINES}"

if [ -n "$RATE_STR" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${C_COST}⚡${RESET} ${RATE_STR}"
fi

COL_CONTENT="${COL_CONTENT} "

# ── Render ───────────────────────────────────────────────────────────────────
echo -e "${COL_CONTENT}"
