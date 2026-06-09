// tests/session-concurrent.test.js
// Dual-purpose: when --session-worker is present, acts as a subprocess that
// calls updateSessionState inside withSessionLock. Otherwise runs as a bun
// test suite verifying concurrent-access safety.
//
// Suite-order-safe: session.js captures ADVISOR_RUNS_ROOT at module load time.
// Spawning child processes rather than importing in-process ensures each worker
// sees its own fresh RUNS_ROOT, immune to module caching across the full suite.

import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const THIS_FILE = fileURLToPath(import.meta.url);

// ── Worker subprocess mode ──────────────────────────────────────────────────
if (process.argv.includes('--session-worker')) {
  const sidIdx = process.argv.indexOf('--sid');
  const widIdx = process.argv.indexOf('--worker-id');
  const sid = process.argv[sidIdx + 1];
  const workerId = process.argv[widIdx + 1];

  // Import fresh — ADVISOR_RUNS_ROOT is already set in this process's env
  // before any module code has run, so RUNS_ROOT captures the tmp dir correctly.
  const { updateSessionState } = await import(`${REPO}/lib/session.js`);

  updateSessionState(sid, (state) => {
    const ids = state.user_prompt ? state.user_prompt.split(',').filter(Boolean) : [];
    ids.push(`w${workerId}`);
    return { ...state, user_prompt: ids.join(',') };
  });

  process.exit(0);
}

// ── Test suite ──────────────────────────────────────────────────────────────
import { test, expect } from 'bun:test';

const N_CONCURRENT = 5;

function spawnWorker(sid, workerId, extraEnv = {}) {
  return Bun.spawn(
    ['bun', THIS_FILE, '--session-worker', '--sid', sid, '--worker-id', String(workerId)],
    {
      env: { ...process.env, ...extraEnv },
      stderr: 'pipe',
    }
  );
}

// C1: N concurrent patchers via withSessionLock must not lose any update.
test('concurrent patchers via withSessionLock do not lose updates', async () => {
  const tmpRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-concurrent-'));
  try {
    const sid = 'concurrent-no-loss';
    const workerEnv = { ADVISOR_RUNS_ROOT: tmpRunsRoot };

    const workers = Array.from({ length: N_CONCURRENT }, (_, i) =>
      spawnWorker(sid, i, workerEnv)
    );
    const exits = await Promise.all(workers.map((w) => w.exited));

    for (const code of exits) {
      expect(code).toBe(0);
    }

    const statePath = path.join(tmpRunsRoot, sid, 'session.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ids = state.user_prompt.split(',').filter(Boolean);

    expect(ids).toHaveLength(N_CONCURRENT);
    for (let i = 0; i < N_CONCURRENT; i++) {
      expect(ids).toContain(`w${i}`);
    }
  } finally {
    fs.rmSync(tmpRunsRoot, { recursive: true, force: true });
  }
}, 30000);

// C2: second caller must block until the first releases the lock.
// Each worker carries a 100 ms artificial delay via ADVISOR_TEST_UPDATE_DELAY_MS
// (captured at session.js load time inside each child process). With N_BLOCK
// workers serialising under the lock, total elapsed time must be at least
// (N_BLOCK - 1) * DELAY_MS — proving that latecomers wait rather than racing.
test('second caller blocks until first releases the lock', async () => {
  const tmpRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-lock-'));
  try {
    const sid = 'lock-block-test';
    const N_BLOCK = 3;
    const DELAY_MS = 100;

    const workerEnv = {
      ADVISOR_RUNS_ROOT: tmpRunsRoot,
      ADVISOR_TEST_UPDATE_DELAY_MS: String(DELAY_MS),
    };

    const t0 = Date.now();
    const workers = Array.from({ length: N_BLOCK }, (_, i) =>
      spawnWorker(sid, i, workerEnv)
    );
    await Promise.all(workers.map((w) => w.exited));
    const elapsed = Date.now() - t0;

    // Workers serialize; minimum total >= (N_BLOCK - 1) * DELAY_MS.
    expect(elapsed).toBeGreaterThanOrEqual((N_BLOCK - 1) * DELAY_MS);

    // Data integrity: all N_BLOCK IDs survive in the final state.
    const statePath = path.join(tmpRunsRoot, sid, 'session.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ids = state.user_prompt.split(',').filter(Boolean);
    expect(ids).toHaveLength(N_BLOCK);
  } finally {
    fs.rmSync(tmpRunsRoot, { recursive: true, force: true });
  }
}, 30000);
