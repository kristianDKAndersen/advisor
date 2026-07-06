import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { injectWorkerHooks } from '../lib/summon.js';

const STOP_TELEMETRY = path.resolve(import.meta.dir, '../.claude/hooks/stop-telemetry.js');

// Root cause: injectWorkerHooks' Stop array never included stop-telemetry.js,
// so worker sessions' settings.json (built by provisionOne) never ran the
// telemetry hook that appends to token-usage.jsonl. Only the advisor's own
// top-level .claude/settings.json wired it up.
test('injectWorkerHooks registers stop-telemetry.js on the Stop event', () => {
  const hooks = injectWorkerHooks({});
  expect(hooks.Stop).toBeDefined();
  const commands = hooks.Stop.flatMap((entry) => entry.hooks.map((h) => h.command));
  expect(commands.some((c) => c.includes('stop-telemetry.js'))).toBe(true);
});

test('injectWorkerHooks preserves the existing worker-result-check.js Stop hook', () => {
  const hooks = injectWorkerHooks({});
  const commands = hooks.Stop.flatMap((entry) => entry.hooks.map((h) => h.command));
  expect(commands.some((c) => c.includes('worker-result-check.js'))).toBe(true);
});

let tmpDir;
let stateDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-stop-telemetry-'));
  stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTranscript(sessionUuid, tokenCounts) {
  return tokenCounts
    .map((u) =>
      JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: u },
      })
    )
    .join('\n') + '\n';
}

// Simulates exactly how Claude Code invokes a Stop hook inside a worker
// session's worktree: stdin carries {session_id, transcript_path}, cwd is the
// worker's $REPO worktree, and ADVISOR_STATE_DIR is set (as it is for the
// advisor-cost CLI) so the row lands somewhere assertable instead of the
// real ~/.advisor/state.
test('stop-telemetry.js invoked in a worker context appends a usage row keyed by the claude session uuid', () => {
  const sessionUuid = 'ab12cd34-worker-session-uuid';
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
    makeTranscript(sessionUuid, [
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    ])
  );

  const workerWorktree = path.join(tmpDir, 'worker-worktree');
  fs.mkdirSync(workerWorktree, { recursive: true });

  const result = spawnSync('node', [STOP_TELEMETRY], {
    input: JSON.stringify({ session_id: sessionUuid, transcript_path: transcriptPath }),
    encoding: 'utf8',
    cwd: workerWorktree,
    env: {
      ...process.env,
      ADVISOR_STATE_DIR: stateDir,
      ADVISOR_WORKER_HOOKS: '1',
    },
  });

  expect(result.status).toBe(0);

  const tokenLogPath = path.join(stateDir, 'token-usage.jsonl');
  expect(fs.existsSync(tokenLogPath)).toBe(true);
  const rows = fs.readFileSync(tokenLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((r) => r.sid === sessionUuid);
  expect(row).toBeDefined();
  expect(row.total_used).toBe(165);
  expect(row.breakdown.input_tokens).toBe(100);
  expect(row.breakdown.output_tokens).toBe(50);
});
