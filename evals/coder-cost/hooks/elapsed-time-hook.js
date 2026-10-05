#!/usr/bin/env bun
// PostToolUse hook: injects elapsed wall-clock time since the eval run started.
// PostToolUse fires after every tool call (unlike UserPromptSubmit, which fires
// once per `-p` invocation and was inert for this purpose). Start time comes
// from CODER_COST_START_MS, set by run.js in the child process env.
const startMs = Number(process.env.CODER_COST_START_MS);
const elapsedSec = Number.isFinite(startMs) ? Math.round((Date.now() - startMs) / 1000) : null;
const message = elapsedSec != null ? `Elapsed time: ${elapsedSec} seconds` : 'Elapsed time: unknown (no start marker found)';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: message,
  },
}));
process.exit(0);
