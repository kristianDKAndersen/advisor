#!/usr/bin/env node
// PreToolUse hook: block Edit/Write to ephemeral worker workspace paths.
// Blocking convention (Claude Code docs, 2026-05): exit 2 = universal block signal.
// Stdout output is shown to Claude as the refusal reason.
'use strict';
const os = require('os');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let msg;
  try { msg = JSON.parse(raw); } catch { process.exit(0); }

  const { tool_name, tool_input } = msg;
  if (tool_name !== 'Edit' && tool_name !== 'Write') process.exit(0);

  const filePath = tool_input && tool_input.file_path;
  if (!filePath) process.exit(0);

  const runsRoot = process.env.ADVISOR_RUNS_ROOT || path.join(os.homedir(), '.advisor', 'runs');
  // Match <runsRoot>/<session-id>/workspace/ prefix
  const escaped = runsRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^' + escaped + '/[^/]+/workspace/');

  if (pattern.test(filePath)) {
    process.stdout.write(
      `workspace-guard: blocked ${tool_name} to ephemeral workspace path: ${filePath}\n` +
      `Worker workspaces under ${runsRoot}/<sid>/workspace/ are ephemeral and must not be edited directly.\n` +
      `Write deliverables to $OUTPUT_DIR instead.\n`
    );
    process.exit(2);
  }

  process.exit(0);
});
