#!/usr/bin/env bun
// UserPromptSubmit hook: injects elapsed wall-clock time since the eval run started.
// Reads a start timestamp written by run.js into .eval-start-ts at worktree root.
const fs = require('fs');
const path = require('path');

const markerPath = path.join(process.cwd(), '.eval-start-ts');
let elapsedMsg = 'Elapsed time so far: unknown (no start marker found)';
try {
  const startMs = Number(fs.readFileSync(markerPath, 'utf8').trim());
  if (Number.isFinite(startMs)) {
    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    elapsedMsg = `Elapsed time so far: ${elapsedSec}s`;
  }
} catch (e) {
  // leave default message
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: elapsedMsg,
  },
}));
process.exit(0);
