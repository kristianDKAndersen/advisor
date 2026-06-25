import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const HOOKS_DIR = path.join(ADVISOR_ROOT, 'lib', 'hooks');
const WORKER_TRACE_JS = path.join(HOOKS_DIR, 'worker-trace.js');
const WORKER_INBOX_POLL_SH = path.join(HOOKS_DIR, 'worker-inbox-poll.sh');
const WORKER_AUTO_CLOSE_SH = path.join(HOOKS_DIR, 'worker-auto-close.sh');

let tmpDir;
let mockAdvDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
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

// ────────────────────────────────────────────────────────────────────────────
// H3: worker-trace.js
// ────────────────────────────────────────────────────────────────────────────

test('H3: trace line written with correct fields (AT-3.1)', () => {
  const traceFile = path.join(tmpDir, 'trace.jsonl');
  if (fs.existsSync(traceFile)) fs.unlinkSync(traceFile);

  const input = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: '/Users/x/foo.ts' },
    tool_response: { output: 'const x = 1;' }
  });

  const result = spawnSync('node', [WORKER_TRACE_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, OUTPUT_DIR: tmpDir, ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(traceFile)).toBe(true);

  const line = JSON.parse(fs.readFileSync(traceFile, 'utf8').trim());
  expect(line.tool).toBe('Read');
  expect(line.args_summary).toContain('/Users/x/foo.ts');
  expect(line.result_summary).toContain('const x');
  expect(typeof line.ts).toBe('number');
  expect(line.ts).toBeGreaterThan(0);
});

test('H3: args_summary truncated at 120 chars (AT-3.2)', () => {
  const traceFile = path.join(tmpDir, 'trace-trunc.jsonl');
  if (fs.existsSync(traceFile)) fs.unlinkSync(traceFile);

  const longCmd = 'A'.repeat(200);
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: longCmd },
    tool_response: { output: 'done' }
  });

  const result = spawnSync('node', [WORKER_TRACE_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, OUTPUT_DIR: path.join(tmpDir, 'trunc-output'), ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  const line = JSON.parse(fs.readFileSync(path.join(tmpDir, 'trunc-output', 'trace.jsonl'), 'utf8').trim());
  expect(line.args_summary.length).toBeLessThanOrEqual(120);
});

test('H3: missing OUTPUT_DIR exits 0 without crash (AT-3.3)', () => {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { output: 'ok' }
  });
  const env = { ...process.env };
  delete env.OUTPUT_DIR;

  const result = spawnSync('node', [WORKER_TRACE_JS], {
    input,
    encoding: 'utf8',
    env
  });

  expect(result.status).toBe(0);
});

test('H3: ADVISOR_WORKER_HOOKS=0 disables trace (no file written)', () => {
  const outputDir = path.join(tmpDir, 'disabled-output');
  fs.mkdirSync(outputDir, { recursive: true });
  const traceFile = path.join(outputDir, 'trace.jsonl');

  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { output: 'ok' }
  });

  const result = spawnSync('node', [WORKER_TRACE_JS], {
    input,
    encoding: 'utf8',
    env: { ...process.env, OUTPUT_DIR: outputDir, ADVISOR_WORKER_HOOKS: '0' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(traceFile)).toBe(false);
});

// ────────────────────────────────────────────────────────────────────────────
// H1: worker-inbox-poll.sh
// ────────────────────────────────────────────────────────────────────────────

test('H1: missing inbox file exits 0 without crash (AT-1.4)', () => {
  const result = spawnSync('bash', [WORKER_INBOX_POLL_SH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INBOX: '/tmp/nonexistent-inbox-test-xyz.jsonl',
      ADV: ADVISOR_ROOT,
      ADVISOR_WORKER_HOOKS: '1'
    }
  });
  expect(result.status).toBe(0);
});

test('H1: ADVISOR_WORKER_HOOKS=0 exits immediately', () => {
  const result = spawnSync('bash', [WORKER_INBOX_POLL_SH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INBOX: '/tmp/nonexistent-inbox.jsonl',
      ADV: ADVISOR_ROOT,
      ADVISOR_WORKER_HOOKS: '0'
    }
  });
  expect(result.status).toBe(0);
});

test('H1: guidance message surfaced to stderr (AT-1.2)', () => {
  const channelDir = path.join(tmpDir, 'h1-channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const inbox = path.join(channelDir, 'inbox.jsonl');
  // Manually write a guidance message (bypass channel.js seq lock for test isolation)
  fs.writeFileSync(inbox, JSON.stringify({ type: 'guidance', body: 'use async approach', from: 'advisor', seq: 1, ts: Date.now() / 1000 }) + '\n');

  const result = spawnSync('bash', [WORKER_INBOX_POLL_SH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INBOX: inbox,
      ADV: ADVISOR_ROOT,
      ADVISOR_WORKER_HOOKS: '1'
    }
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toContain('advisor-guidance');
  expect(result.stderr).toContain('async approach');
});

test('H1: last_seq advances so guidance is not re-delivered (AT-1.3)', () => {
  const channelDir = path.join(tmpDir, 'h1-seq-channel');
  fs.mkdirSync(channelDir, { recursive: true });
  const inbox = path.join(channelDir, 'inbox.jsonl');
  const seqFile = path.join(channelDir, 'hook-last-seq');

  // Write msg1 at seq 1
  fs.writeFileSync(inbox, JSON.stringify({ type: 'guidance', body: 'msg1', from: 'advisor', seq: 1, ts: Date.now() / 1000 }) + '\n');

  const env = { ...process.env, INBOX: inbox, ADV: ADVISOR_ROOT, ADVISOR_WORKER_HOOKS: '1' };

  // First poll — delivers msg1
  const r1 = spawnSync('bash', [WORKER_INBOX_POLL_SH], { encoding: 'utf8', env });
  expect(r1.status).toBe(0);
  expect(r1.stderr).toContain('msg1');

  // Append msg2 at seq 2
  fs.appendFileSync(inbox, JSON.stringify({ type: 'guidance', body: 'msg2', from: 'advisor', seq: 2, ts: Date.now() / 1000 }) + '\n');

  // Second poll — delivers msg2, not msg1
  const r2 = spawnSync('bash', [WORKER_INBOX_POLL_SH], { encoding: 'utf8', env });
  expect(r2.status).toBe(0);
  expect(r2.stderr).toContain('msg2');
  expect(r2.stderr).not.toContain('msg1');
});

// ────────────────────────────────────────────────────────────────────────────
// H2: worker-auto-close.sh
// ────────────────────────────────────────────────────────────────────────────

test('H2: progress send does NOT trigger close-tab (AT-2.2)', () => {
  const flagFile = path.join(tmpDir, 'close-tab-flag-progress');
  if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);

  // Create mock ADV with close-tab writing this flag
  const mockDir = path.join(tmpDir, 'mock-adv-progress');
  fs.mkdirSync(path.join(mockDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(mockDir, 'bin', 'close-tab'), `#!/usr/bin/env bash\ntouch "${flagFile}"\n`, { mode: 0o755 });

  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: `bun "$ADV/lib/channel.js" send --file "$OUTBOX" --type progress --body "step done"` },
    tool_response: { output: '' }
  });

  const result = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADV: mockDir, OUTBOX: '/tmp/test-outbox.jsonl', ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(flagFile)).toBe(false);
});

test('H2: result send triggers close-tab (AT-2.1)', () => {
  const flagFile = path.join(tmpDir, 'close-tab-flag-result');
  if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);

  const mockDir = path.join(tmpDir, 'mock-adv-result');
  fs.mkdirSync(path.join(mockDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(mockDir, 'bin', 'close-tab'), `#!/usr/bin/env bash\ntouch "${flagFile}"\n`, { mode: 0o755 });

  const outbox = path.join(tmpDir, 'outbox.jsonl');
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: `bun "$ADV/lib/channel.js" send --file "${outbox}" --type result --body "{}"` },
    tool_response: { output: '' }
  });

  const result = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADV: mockDir, OUTBOX: outbox, ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(flagFile)).toBe(true);
});

test('H2: ADVISOR_WORKER_HOOKS=0 disables hook (AT-2.4)', () => {
  const flagFile = path.join(tmpDir, 'close-tab-flag-disabled');
  if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);

  const mockDir = path.join(tmpDir, 'mock-adv-disabled');
  fs.mkdirSync(path.join(mockDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(mockDir, 'bin', 'close-tab'), `#!/usr/bin/env bash\ntouch "${flagFile}"\n`, { mode: 0o755 });

  const outbox = path.join(tmpDir, 'outbox-disabled.jsonl');
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: `bun "$ADV/lib/channel.js" send --file "${outbox}" --type result --body "{}"` },
    tool_response: { output: '' }
  });

  const result = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADV: mockDir, OUTBOX: outbox, ADVISOR_WORKER_HOOKS: '0' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(flagFile)).toBe(false);
});

test('H2: non-Bash tool call exits 0 without action (AT-2.3)', () => {
  const flagFile = path.join(tmpDir, 'close-tab-flag-read');
  if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);

  const mockDir = path.join(tmpDir, 'mock-adv-read');
  fs.mkdirSync(path.join(mockDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(mockDir, 'bin', 'close-tab'), `#!/usr/bin/env bash\ntouch "${flagFile}"\n`, { mode: 0o755 });

  const input = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: '/foo/bar' },
    tool_response: { output: 'file content' }
  });

  const result = spawnSync('bash', [WORKER_AUTO_CLOSE_SH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ADV: mockDir, OUTBOX: '/tmp/outbox.jsonl', ADVISOR_WORKER_HOOKS: '1' }
  });

  expect(result.status).toBe(0);
  expect(fs.existsSync(flagFile)).toBe(false);
});

// ────────────────────────────────────────────────────────────────────────────
// Hook centralization in summon.js (Fix #4)
// ────────────────────────────────────────────────────────────────────────────

test('summon.js centralizes PostToolUse hooks with correct matchers (Fix #4-1)', () => {
  const summonSource = fs.readFileSync(path.join(ADVISOR_ROOT, 'lib', 'summon.js'), 'utf8');
  // Source must reference PostToolUse, all 3 hook scripts, and both empty and Bash matchers
  expect(summonSource).toContain('PostToolUse');
  expect(summonSource).toContain('worker-trace.js');
  expect(summonSource).toContain('worker-inbox-poll.sh');
  expect(summonSource).toContain('worker-auto-close.sh');
  // Exact matchers: two empty-string entries and one 'Bash'
  const emptyMatcherCount = (summonSource.match(/matcher: ''/g) || []).length;
  expect(emptyMatcherCount).toBeGreaterThanOrEqual(4); // PreToolUse + PreCompact + 2 PostToolUse
  expect(summonSource).toContain("matcher: 'Bash'");
});

test('summon.js injects ADVISOR_WORKER_HOOKS env correctly (Fix #4-2)', () => {
  const summonSource = fs.readFileSync(path.join(ADVISOR_ROOT, 'lib', 'summon.js'), 'utf8');
  expect(summonSource).toContain('ADVISOR_WORKER_HOOKS');
  // Worker-hooks are now universal (promoted to all agents) — no allowlist.
  expect(summonSource).not.toContain('WORKER_HOOKS_ALLOWLIST');
  expect(summonSource).toContain("'1'");
});
