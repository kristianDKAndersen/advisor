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
    tool_response: { output: '#1 [result] {}' }
  });

  const result = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADV: mockAdvDir, OUTBOX: outbox, ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(flagFile)).toBe(true);
});

// CB14: close only after a real, successful result send (not text that merely mentions one).
const SEND = 'bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type result --body \'{"summary":"x"}\' --from coder';
const MARKER = '#7 [result] (coder) {"summary":"x"}';
const resultLine = (ageSec) =>
  JSON.stringify({ ts: Date.now() / 1000 - ageSec, type: 'result', body: '{}', from: 'coder', seq: 7 }) + '\n';

function runHook(command, { output = '', outboxContent = '', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'case-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const log = path.join(dir, 'close-tab.log');
  fs.writeFileSync(path.join(dir, 'bin', 'close-tab'), `#!/usr/bin/env bash\necho fired >> "${log}"\n`, { mode: 0o755 });
  const outbox = path.join(dir, 'outbox.jsonl');
  fs.writeFileSync(outbox, outboxContent);
  const r = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { output } }),
    encoding: 'utf8',
    env: { ...process.env, ADV: dir, OUTBOX: outbox, ADVISOR_WORKER_HOOKS: '1', ...env }
  });
  expect(r.status).toBe(0);
  return fs.existsSync(log);
}

test('CB14: real result send with success marker closes', () => {
  expect(runHook(SEND, { output: MARKER })).toBe(true);
});

test('CB14: quiet result send (empty output) closes when outbox ends in a fresh result line', () => {
  expect(runHook(SEND + ' --quiet', { outboxContent: resultLine(1) })).toBe(true);
});

test('CB14: quiet result send does NOT close when outbox result line is stale', () => {
  expect(runHook(SEND + ' --quiet', { outboxContent: resultLine(120) })).toBe(false);
});

test('CB14: real send after a heredoc and after cd still closes', () => {
  const withHeredoc = `cat > /tmp/x.txt <<'EOF'\nnot a send\nEOF\n${SEND}`;
  expect(runHook(withHeredoc, { output: MARKER })).toBe(true);
  expect(runHook(`cd /tmp && ${SEND}`, { output: MARKER })).toBe(true);
});

// Negatives are adversarial: success marker AND a fresh outbox result line are both present,
// so only the command parse can keep the hook from firing.
const NEGATIVES = {
  heredoc: `cat > x.js <<EOF\nbun "$ADV/lib/channel.js" send --file "$OUTBOX" --type result --body '{}'\nEOF`,
  'indented heredoc (<<-, quoted delimiter)': `cat > x.js <<-'EOF'\n\tbun channel.js send --file outbox.jsonl --type result\n\tEOF`,
  echo: `echo 'bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type result --body x'`,
  printf: `printf '%s\\n' "bun channel.js send --file outbox.jsonl --type result" > fixture.txt`,
  grep: `grep -rn "channel.js send --file $OUTBOX --type result" lib/`,
  'node -e': `node -e "console.log('bun channel.js send --file outbox.jsonl --type result')"`,
  'progress send': 'bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type progress --body "result outbox.jsonl"',
  'result-check type': 'bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type result-check',
  'send to a non-outbox file': 'bun "$ADV/lib/channel.js" send --file /tmp/scratch.jsonl --type result --body x',
  'comment text': `ls # bun channel.js send --file "$OUTBOX" --type result`,
};
for (const [name, cmd] of Object.entries(NEGATIVES)) {
  test(`CB14: ${name} does NOT close`, () => {
    expect(runHook(cmd, { output: MARKER, outboxContent: resultLine(1) })).toBe(false);
  });
}

test('CB14: result send whose output shows failure does NOT close', () => {
  expect(runHook(SEND, { output: 'Error: --file is required' })).toBe(false);
  expect(runHook(SEND, { output: 'Error: --type is required for send', outboxContent: '' })).toBe(false);
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
  // Node (now in the match script) must still read stdin directly
  const matchContent = fs.readFileSync(path.join(HOOKS_DIR, 'worker-auto-close-match.js'), 'utf8');
  expect(matchContent).toContain("readFileSync(0, 'utf8')");
});
