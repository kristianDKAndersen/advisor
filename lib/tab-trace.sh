#!/usr/bin/env bash
# Shared helper sourced by bin/close-tab and bin/close-worker-tab.
# Writes one trace line to ~/.advisor/state/tab-close-trace.log.
#
# Reads: $sid variable from the caller's scope (defaults to '-' when unset/empty).
# Args: $1=action, $2=tty (both optional, default to '-').
_tab_trace() {
  mkdir -p "$HOME/.advisor/state" || true
  printf '%s %s sid=%s tty=%s action=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$0")" "${sid:--}" "${2:--}" "$1" \
    >> "$HOME/.advisor/state/tab-close-trace.log" || true
}
