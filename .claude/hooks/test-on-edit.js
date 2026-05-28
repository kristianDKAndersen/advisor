#!/usr/bin/env node
// PostToolUse hook: when a worker edits lib/<name>.js, auto-run tests/<name>.test.js.
// Always exits 0 — hook errors must not block tool use.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

async function main() {
  if (process.env.ADVISOR_TEST_ON_EDIT === '0') return;

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try { event = JSON.parse(raw); } catch { return; }

  const filePath = event?.tool_input?.file_path;
  if (!filePath) return;

  const match = filePath.match(/(^|\/)lib\/([^/]+)\.js$/);
  if (!match) return;

  const name = match[2];
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) return;

  const testFile = path.join(projectDir, 'tests', `${name}.test.js`);
  if (!fs.existsSync(testFile)) return;

  const start = Date.now();
  const result = spawnSync('bun', ['test', `tests/${name}.test.js`], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const elapsed = Date.now() - start;

  const summary = {
    test_file: `tests/${name}.test.js`,
    exit_code: result.status,
    elapsed_ms: elapsed,
    stdout: (result.stdout || '').toString().slice(0, 500),
    stderr: (result.stderr || '').toString().slice(0, 500)
  };

  process.stderr.write(JSON.stringify(summary) + '\n');
}

main().catch(() => {});
