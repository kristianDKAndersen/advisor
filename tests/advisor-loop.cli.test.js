const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'advisor-loop');
const { main } = require(CLI);

function runCli(args) {
  const res = childProcess.spawnSync('bun', [CLI, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function makeTmpRepo() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-cli-'));
  childProcess.execFileSync('git', ['-C', dir, 'init', '-q']);
  childProcess.execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  childProcess.execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  childProcess.execFileSync('git', ['-C', dir, 'add', '-A']);
  childProcess.execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// ── 1. usage ──────────────────────────────────────────────────────────────

test('no arguments prints usage and exits non-zero', () => {
  const res = runCli([]);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain('Usage: bin/advisor-loop');
});

test('missing --goal prints usage and exits non-zero', () => {
  const res = runCli(['--dry-run']);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain('Usage: bin/advisor-loop');
});

// ── 3. bar resolution and exit 6 ─────────────────────────────────────────

test('no bar inputs at all exits 6 with a stderr message', () => {
  const res = runCli(['--goal', 'do the thing']);
  expect(res.status).toBe(6);
  expect(res.stderr).toContain('no comparison bar could be declared');
});

test('--refine without round-0 artifacts exits 6', () => {
  const res = runCli(['--goal', 'do the thing', '--refine']);
  expect(res.status).toBe(6);
  expect(res.stderr).toContain('no comparison bar could be declared');
});

// ── 4. precedence hole fix ───────────────────────────────────────────────

test('--bar-type without --bar-ref is rejected with a clear message and non-zero exit', () => {
  const res = runCli(['--goal', 'do the thing', '--bar-type', 'external-reference']);
  expect(res.status).not.toBe(0);
  expect(res.status).not.toBe(6);
  expect(res.stderr).toContain('--bar-type "external-reference" requires --bar-ref');
});

test('--bar-ref without --bar-type is rejected', () => {
  const res = runCli(['--goal', 'do the thing', '--bar-ref', '/tmp/ref.png']);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain('--bar-ref requires --bar-type');
});

test('--bar-type prior-round without --bar-ref is the documented exception (falls through to refine path, not rejected)', () => {
  const res = runCli(['--goal', 'do the thing', '--bar-type', 'prior-round']);
  // Not rejected at the flag-validation boundary — it proceeds to resolveBar's
  // refine path, which (with no round-0 artifacts available) exits 6, not the
  // flag-validation error.
  expect(res.status).toBe(6);
  expect(res.stderr).not.toContain('requires --bar-ref');
  expect(res.stderr).toContain('no comparison bar could be declared');
});

// ── 5. state init and autonomy persistence ───────────────────────────────

test('autonomy_level defaults to L2 and is persisted to round_state.json', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--dry-run'],
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.autonomy_level).toBe('L2');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('--autonomy L3 is written to round_state.json', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--autonomy', 'L3', '--repo-root', repoRoot, '--output-dir', outputDir, '--dry-run'],
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.autonomy_level).toBe('L3');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

// ── 6. dry run ────────────────────────────────────────────────────────────

test('--dry-run exits 0, prints the plan, creates no worktree, and never calls runLoop', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  let runLoopCalled = false;
  const stdoutChunks = [];
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--dry-run'],
      {
        runLoopFn: async () => { runLoopCalled = true; },
        stdout: { write: (s) => stdoutChunks.push(s) },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(runLoopCalled).toBe(false);

    const plan = JSON.parse(stdoutChunks.join(''));
    expect(plan.goal).toBe('do the thing');
    expect(plan.bar).toEqual({ type: 'external-reference', ref: '/tmp/ref.png' });

    const wtList = childProcess.execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    // Only the main worktree (the repo root itself) is listed — no additional
    // worktree was created for this dry run.
    expect(wtList.trim().split('\n\n').length).toBe(1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

// ── 7. delegate, do not reimplement ──────────────────────────────────────

test('non-dry-run invocation delegates to runLoop exactly once with the initialized state', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  let callCount = 0;
  let receivedState = null;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir],
      {
        runLoopFn: async (state) => { callCount++; receivedState = state; },
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(callCount).toBe(1);
    expect(receivedState.goal).toBe('do the thing');
    expect(receivedState.autonomy_level).toBe('L2');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

// ── source-level check: no round loop / critic / gate logic in the CLI ───

test('bin/advisor-loop source contains no round loop, critic, or gate logic of its own', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  expect(src).not.toMatch(/while\s*\(/);
  expect(src).not.toContain('checkGate');
  expect(src).not.toContain('loop-critic');
  expect(src).not.toContain('decide(');
});
