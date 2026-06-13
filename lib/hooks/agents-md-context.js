#!/usr/bin/env node
// PreToolUse hook: injects the nearest AGENTS.md into context before Edit/Write/NotebookEdit.
// Prints hookSpecificOutput JSON if a governing AGENTS.md is found; otherwise silent.
// NEVER exits non-zero — informational only, never blocks.
'use strict';
const fs = require('fs');
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

function resolveRepoRoot() {
  if (process.env.REPO) return path.resolve(process.env.REPO);
  if (process.env.ADV) return path.resolve(process.env.ADV);
  try {
    const { execSync } = require('child_process');
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch (_) {}
  return null;
}

function findNearestAgentsMd(startDir, repoRoot) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'AGENTS.md');
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch (_) {}
    if (repoRoot && path.resolve(dir) === path.resolve(repoRoot)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

module.exports = { findNearestAgentsMd, resolveRepoRoot };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { process.exit(0); }

    const { tool_name, tool_input } = msg || {};
    if (!EDIT_TOOLS.has(tool_name)) process.exit(0);

    const filePath = tool_input && tool_input.file_path;
    if (!filePath) process.exit(0);

    const startDir = path.dirname(path.resolve(filePath));
    const repoRoot = resolveRepoRoot();
    const agentsMd = findNearestAgentsMd(startDir, repoRoot);
    if (!agentsMd) process.exit(0);

    let contents;
    try { contents = fs.readFileSync(agentsMd, 'utf8'); } catch { process.exit(0); }

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `read-before-edit: ${agentsMd} governs this path —\n${contents}`,
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(0);
  });
}
