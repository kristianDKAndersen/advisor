#!/usr/bin/env node
// PreToolUse hook: block Edit/Write if coder worktree is on the wrong branch.
// Fail-open on every ambiguous case: not Edit/Write, INBOX unset, no sid in INBOX,
// git exits non-zero (non-git copyDir workspace), or empty branch (detached HEAD).
// Block (exit 2) only when git returns a non-empty branch != ws/<sid>.
'use strict';
const { execFileSync } = require('child_process');

function extractSid(inbox) {
  if (!inbox) return null;
  const m = inbox.match(/\/runs\/([^/]+)\/channel/);
  return m ? m[1] : null;
}

module.exports = { extractSid };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { process.exit(0); }
    if (!msg || (msg.tool_name !== 'Edit' && msg.tool_name !== 'Write')) process.exit(0);

    const sid = extractSid(process.env.INBOX);
    if (!sid) process.exit(0);
    const expectedBranch = `ws/${sid}`;

    const workspace = process.env.CLAUDE_PROJECT_DIR || process.cwd();

    let currentBranch;
    try {
      currentBranch = execFileSync(
        'git', ['-C', workspace, 'branch', '--show-current'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {
      process.exit(0); // not a git repo (copyDir worker) or git missing
    }

    if (!currentBranch) process.exit(0); // detached HEAD — fail-open

    if (currentBranch !== expectedBranch) {
      process.stdout.write(
        `branch-guard: blocked ${msg.tool_name} — worktree is on wrong branch.\n` +
        `  Expected: ${expectedBranch}\n` +
        `  Current:  ${currentBranch}\n` +
        `Do not edit files on a branch other than your assigned worktree branch.\n`
      );
      process.exit(2);
    }

    process.exit(0);
  });
}
