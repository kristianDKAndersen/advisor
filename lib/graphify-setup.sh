#!/usr/bin/env bash
set -euo pipefail

# One-time graphify pre-index helper. Run once per repo to build the code graph.

if ! command -v graphify >/dev/null 2>&1; then
  echo "graphify not found. Install it first: npm install -g @graphify/cli"
  echo "Then re-run this script."
  exit 0
fi

echo "Building keyless code-only index..."
graphify update . --no-cluster

echo ""
echo "Done. To persist the graph, commit the following files:"
echo "  git add graphify-out/graph.json GRAPH_REPORT.md"
echo "  git commit -m 'chore: update graphify index'"
echo "(Note: graph.json may be gitignored in this repo — treat the above as guidance.)"

echo ""
echo "Installing auto-rebuild hook..."
graphify hook install

echo "Setup complete."
