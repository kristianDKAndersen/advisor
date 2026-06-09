import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const HOOKS_DIR = path.join(ADVISOR_ROOT, 'lib', 'hooks');
const WORKER_AUTO_CLOSE_SH = path.join(HOOKS_DIR, 'worker-auto-close.sh');

let tmpDir;
let mockAdvDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-auto-close-test-'));
  // Create a mock ADV dir with a bin/close-tab that writes a flag file
  mockAdvDir = path.join(tmpDir, 'mock-adv');
  fs.mkdirSync(path.join(mockAdvDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(mockAdvDir, 'bin', 'close-tab'),
    `#!/usr/bin/env bash\necho "close-tab-fired" > "${tmpDir}/close-tab-flag"\n`,
    { mode: 0o755 }
  );
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Characterization of pre-fix state (skipped post-fix; serves as RED documentation in changelog).
// On git HEAD (pre-fix), this test PASSED confirming the bug existed.
test.skip('PRE-FIX characterization: worker-auto-close had kill -TERM walk (AT-7.1 RED-doc)', () => {
  const scriptContent = fs.readFileSync(WORKER_AUTO_CLOSE_SH, 'utf8');
  expect(scriptContent).toContain('kill -TERM');
  expect(scriptContent).toContain('_claude_pid');
  expect(scriptContent).toContain('for _i in 1 2 3');
});

// Test that worker-auto-close still invokes close-tab on result match
test('H2-EXT: result send triggers close-tab (AT-7.2)', () => {
  const flagFile = path.join(tmpDir, 'close-tab-flag');
  if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);

  const outbox = path.join(tmpDir, 'outbox.jsonl');
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: `bun "$ADV/lib/channel.js" send --file "${outbox}" --type result --body "{}"` },
    tool_response: { output: '' }
  });

  const result = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADV: mockAdvDir, OUTBOX: outbox, ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(flagFile)).toBe(true);
});

// Green test: after fix, worker-auto-close no longer contains its own kill -TERM walk (AT-7.3 GREEN)
test('AFTER FIX: worker-auto-close does NOT contain kill -TERM walk (AT-7.3 GREEN)', () => {
  const scriptContent = fs.readFileSync(WORKER_AUTO_CLOSE_SH, 'utf8');
  expect(scriptContent).not.toContain('kill -TERM');
  expect(scriptContent).not.toContain('_claude_pid');
  expect(scriptContent).not.toContain('for _i in 1 2 3');
  // Must still delegate to close-tab
  expect(scriptContent).toContain('bin/close-tab');
});

// [N3] Structural: echo "$INPUT" subshell pipe for large stdin must be removed.
// Pre-fix the script has INPUT=$(cat) and echo "$INPUT" | node -e ..., which truncates
// large payloads in some shells. Post-fix, node reads stdin directly via fd 0.
test('[N3] worker-auto-close.sh does not use echo "$INPUT" pipe; node reads stdin directly', () => {
  const scriptContent = fs.readFileSync(WORKER_AUTO_CLOSE_SH, 'utf8');
  expect(scriptContent).not.toContain('INPUT=$(cat)');
  expect(scriptContent).not.toContain('echo "$INPUT"');
  // Node must still read stdin directly
  expect(scriptContent).toContain("readFileSync(0,'utf8')");
});
