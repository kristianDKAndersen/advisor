#!/usr/bin/env bun
'use strict';
/*
 * Regenerates the `brief` field of every case in cases.jsonl from the FULL
 * `git log -1 --format=%B <solution_sha>` message (trailers stripped), wrapped
 * in a fixed autonomous-worker instruction preamble. Re-run after adding or
 * re-mining cases. Usage: bun evals/coder-cost/build-briefs.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EVAL_DIR = __dirname;
const REPO_ROOT = process.env.CODER_COST_REPO_ROOT || path.resolve(EVAL_DIR, '..', '..');
const CASES_FILE = process.env.CODER_COST_CASES_FILE || path.join(EVAL_DIR, 'cases.jsonl');

const PREAMBLE = 'You are working autonomously in this repository; nobody will answer questions. '
  + 'Implement the change described by the commit message below. Hidden tests will verify it. '
  + 'Do not ask for clarification - make reasonable decisions and finish the work.\n\n';

const TRAILER_RE = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Change-Id|Reported-by|Suggested-by|Helped-by):/i;

function stripTrailers(message) {
  const lines = message.split('\n');
  while (lines.length && (lines[lines.length - 1].trim() === '' || TRAILER_RE.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  return lines.join('\n');
}

function commitMessage(sha) {
  const res = spawnSync('git', ['log', '-1', '--format=%B', sha], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git log failed for ${sha}: ${res.stderr}`);
  return res.stdout.replace(/\n$/, '');
}

function buildBrief(solutionSha) {
  return PREAMBLE + stripTrailers(commitMessage(solutionSha));
}

function main() {
  const lines = fs.readFileSync(CASES_FILE, 'utf8').split('\n').filter(Boolean);
  const out = lines.map((line) => {
    const kase = JSON.parse(line);
    kase.brief = buildBrief(kase.solution_sha);
    return JSON.stringify(kase);
  });
  fs.writeFileSync(CASES_FILE, out.join('\n') + '\n');
  console.log(`Rewrote ${out.length} briefs in ${CASES_FILE}`);
}

if (require.main === module) main();

module.exports = { stripTrailers, commitMessage, buildBrief, PREAMBLE, TRAILER_RE };
