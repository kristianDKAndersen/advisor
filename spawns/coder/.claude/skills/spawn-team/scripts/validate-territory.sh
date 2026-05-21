#!/usr/bin/env bash
# validate-territory.sh — validate a coder-team territory map.
#
# Usage:
#   validate-territory.sh validate <territory.md>
#     Parses the markdown table in <territory.md> and prints any file path
#     that appears in two or more worker rows. Exits non-zero on conflict.
#
#   validate-territory.sh verify <territory.md> [--repo <path>]
#     Compares `git diff --name-only` (in --repo, default $REPO or cwd)
#     against the declared territories and prints:
#       - INTEGRITY VIOLATION: <file> modified by worker <X> but declared in row <Y>
#       - UNDECLARED EDIT:    <file> modified but not in territory map
#       - UNAPPLIED ROW:      <worker> declared <file> but no edit landed
#     Exits non-zero if any integrity violation or undeclared edit is found.
#
# Territory file format: a markdown table with columns
#   | Worker | Files (comma-separated) | Fix IDs |
# Header row and separator row (---) are ignored. Worker name "coder-self"
# or "coder-worker-N" both accepted.
#
# Files within a row are comma-separated. Whitespace around entries is trimmed.

set -euo pipefail

cmd="${1:-}"
territory_file="${2:-}"

if [[ -z "$cmd" || -z "$territory_file" ]]; then
  echo "usage: $0 {validate|verify} <territory.md> [--repo <path>]" >&2
  exit 2
fi

if [[ ! -f "$territory_file" ]]; then
  echo "error: territory file not found: $territory_file" >&2
  exit 2
fi

# Parse repo arg for `verify`.
repo_dir="${REPO:-$(pwd)}"
if [[ "$cmd" == "verify" ]]; then
  shift 2 || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) repo_dir="$2"; shift 2 ;;
      *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
  done
fi

# Parse the markdown table into "<worker><TAB><file>" lines on stdout.
# Skips header (first row containing "Worker" or "Files") and separator (---).
parse_territory() {
  awk -F'|' '
    /^[[:space:]]*\|/ {
      # Strip leading/trailing pipe segments
      worker = $2; files = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", worker)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", files)
      # Skip header
      if (worker == "Worker" || worker ~ /^-+$/ || worker == "") next
      # Split files on comma
      n = split(files, arr, ",")
      for (i = 1; i <= n; i++) {
        f = arr[i]
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", f)
        # Drop trailing column qualifiers like "(no overlap...)" parenthetical headers
        if (f == "" || f ~ /^\(/) continue
        print worker "\t" f
      }
    }
  ' "$1"
}

case "$cmd" in
  validate)
    # Find files appearing in 2+ distinct worker rows.
    parsed=$(parse_territory "$territory_file")
    if [[ -z "$parsed" ]]; then
      echo "error: no rows parsed from $territory_file (is it a markdown table?)" >&2
      exit 2
    fi
    conflicts=$(echo "$parsed" \
      | awk -F'\t' '{ print $2 "\t" $1 }' \
      | sort \
      | awk -F'\t' '
          { if ($1 == prev_file) { workers = workers "," $2; conflict = 1 }
            else { if (conflict) print prev_file ": " workers; prev_file = $1; workers = $2; conflict = 0 }
          }
          END { if (conflict) print prev_file ": " workers }
        ')
    if [[ -n "$conflicts" ]]; then
      echo "TERRITORY CONFLICTS — file appears in multiple worker rows:"
      echo "$conflicts"
      exit 1
    fi
    file_count=$(echo "$parsed" | wc -l | tr -d ' ')
    worker_count=$(echo "$parsed" | awk -F'\t' '{ print $1 }' | sort -u | wc -l | tr -d ' ')
    echo "OK — $file_count file assignments across $worker_count workers, no overlap."
    ;;

  verify)
    if ! command -v git >/dev/null; then
      echo "error: git not found in PATH" >&2; exit 2
    fi
    # Map file -> declared worker(s)
    parsed=$(parse_territory "$territory_file")
    declare_file=$(mktemp)
    echo "$parsed" | awk -F'\t' '{ print $2 "\t" $1 }' | sort > "$declare_file"

    # git diff for modified files
    diff_file=$(mktemp)
    (cd "$repo_dir" && git diff --name-only) | sort > "$diff_file"

    declared_files=$(awk -F'\t' '{ print $1 }' "$declare_file" | sort -u)
    modified_files=$(cat "$diff_file")

    violations=0
    # UNDECLARED EDIT: files modified but not in territory map
    undeclared=$(comm -23 <(echo "$modified_files") <(echo "$declared_files"))
    if [[ -n "$undeclared" ]]; then
      while IFS= read -r f; do
        echo "UNDECLARED EDIT: $f modified but not in territory map"
        violations=$((violations + 1))
      done <<< "$undeclared"
    fi

    # UNAPPLIED ROW: file declared but not modified (warning only — fix may have been a no-op skip)
    unapplied=$(comm -13 <(echo "$modified_files") <(echo "$declared_files"))
    if [[ -n "$unapplied" ]]; then
      while IFS= read -r f; do
        owner=$(awk -F'\t' -v f="$f" '$1 == f { print $2; exit }' "$declare_file")
        echo "UNAPPLIED ROW: $f declared by $owner but no edit landed (may be legitimate skip)"
      done <<< "$unapplied"
    fi

    rm -f "$declare_file" "$diff_file"

    if [[ $violations -gt 0 ]]; then
      echo "FAIL — $violations integrity violation(s) found."
      exit 1
    fi
    echo "OK — all modified files match declared territory."
    ;;

  *)
    echo "unknown command: $cmd" >&2
    echo "usage: $0 {validate|verify} <territory.md> [--repo <path>]" >&2
    exit 2
    ;;
esac
