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

test('--refine without --bar-ref exits 2 naming --bar-ref', () => {
  const res = runCli(['--goal', 'do the thing', '--refine']);
  expect(res.status).toBe(2);
  expect(res.stderr).toContain('--bar-ref');
  expect(res.stderr).not.toContain('no comparison bar could be declared');
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

test('--bar-type prior-round without --bar-ref exits 2 naming --bar-ref', () => {
  const res = runCli(['--goal', 'do the thing', '--bar-type', 'prior-round']);
  expect(res.status).toBe(2);
  expect(res.stderr).toContain('--bar-ref');
  expect(res.stderr).not.toContain('no comparison bar could be declared');
});

// ── 4b. --refine / --bar-type prior-round seeded from --bar-ref ──────────

test('--refine --bar-ref <existing artifact> resolves to a prior-round bar seeded with that path', async () => {
  const artifactPath = path.join(os.tmpdir(), `advisor-loop-artifact-${Date.now()}.txt`);
  fs.writeFileSync(artifactPath, 'artifact\n');
  const repoRoot = makeTmpRepo();
  let plan;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--refine', '--bar-ref', artifactPath,
        '--repo-root', repoRoot, '--dry-run'],
      { stdout: { write: (s) => { plan = JSON.parse(s); } }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    expect(plan.bar).toEqual({ type: 'prior-round', ref: artifactPath });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(artifactPath, { force: true });
  }
});

test('--bar-type prior-round --bar-ref <existing artifact> resolves identically', async () => {
  const artifactPath = path.join(os.tmpdir(), `advisor-loop-artifact-${Date.now()}-b.txt`);
  fs.writeFileSync(artifactPath, 'artifact\n');
  const repoRoot = makeTmpRepo();
  let plan;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'prior-round', '--bar-ref', artifactPath,
        '--repo-root', repoRoot, '--dry-run'],
      { stdout: { write: (s) => { plan = JSON.parse(s); } }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    expect(plan.bar).toEqual({ type: 'prior-round', ref: artifactPath });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(artifactPath, { force: true });
  }
});

test('--refine --bar-ref <nonexistent path> exits 2 naming the path', () => {
  const missingPath = '/tmp/advisor-loop-does-not-exist-xyz.txt';
  const res = runCli(['--goal', 'do the thing', '--refine', '--bar-ref', missingPath]);
  expect(res.status).toBe(2);
  expect(res.stderr).toContain(missingPath);
});

test('--refine --bar-ref <existing artifact> --dry-run exits 0 and creates no state file', () => {
  const artifactPath = path.join(os.tmpdir(), `advisor-loop-artifact-${Date.now()}-c.txt`);
  fs.writeFileSync(artifactPath, 'artifact\n');
  const repoRoot = makeTmpRepo();
  try {
    const res = runCli(['--goal', 'do the thing', '--refine', '--bar-ref', artifactPath,
      '--repo-root', repoRoot, '--dry-run']);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, '.advisor-loop'))).toBe(false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(artifactPath, { force: true });
  }
});

// ── 4c. relative --bar-ref is persisted as a resolved absolute path ─────

test('a relative --bar-ref for prior-round is persisted as the resolved absolute path, still pointing at the same file', async () => {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-cwd-'));
  fs.writeFileSync(path.join(cwd, 'artifact.txt'), 'artifact content\n');
  const repoRoot = makeTmpRepo();
  const priorCwd = process.cwd();
  let plan;
  try {
    process.chdir(cwd);
    const code = await main(
      ['--goal', 'do the thing', '--refine', '--bar-ref', 'artifact.txt',
        '--repo-root', repoRoot, '--dry-run'],
      { stdout: { write: (s) => { plan = JSON.parse(s); } }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    expect(plan.bar.ref).not.toBe('artifact.txt');
    expect(plan.bar.ref).toBe(path.join(cwd, 'artifact.txt'));
    expect(fs.readFileSync(plan.bar.ref, 'utf8')).toBe('artifact content\n');
  } finally {
    process.chdir(priorCwd);
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a relative --bar-type external-reference --bar-ref is persisted as the resolved absolute path', async () => {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-cwd-'));
  fs.writeFileSync(path.join(cwd, 'ref.png'), 'binary-ish content\n');
  const repoRoot = makeTmpRepo();
  const priorCwd = process.cwd();
  let plan;
  try {
    process.chdir(cwd);
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', 'ref.png',
        '--repo-root', repoRoot, '--dry-run'],
      { stdout: { write: (s) => { plan = JSON.parse(s); } }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    expect(plan.bar.ref).not.toBe('ref.png');
    expect(plan.bar.ref).toBe(path.join(cwd, 'ref.png'));
    expect(fs.readFileSync(plan.bar.ref, 'utf8')).toBe('binary-ish content\n');
  } finally {
    process.chdir(priorCwd);
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an acceptance-tests bar ref (a shell command) is left byte-exact, not path-resolved', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const testCommand = 'bun test ./relative/dir';
  let plan;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'acceptance-tests', '--bar-ref', testCommand,
        '--repo-root', repoRoot, '--output-dir', outputDir, '--dry-run'],
      { stdout: { write: (s) => { plan = JSON.parse(s); } }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    expect(plan.bar).toEqual({ type: 'acceptance-tests', ref: testCommand });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a metric bar ref (a threshold descriptor) is left byte-exact, not path-resolved', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const metricRef = 'coverage >= 0.8';
  let plan;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'metric', '--bar-ref', metricRef,
        '--repo-root', repoRoot, '--output-dir', outputDir, '--dry-run'],
      { stdout: { write: (s) => { plan = JSON.parse(s); } }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    expect(plan.bar).toEqual({ type: 'metric', ref: metricRef });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

// ── 4d. test_command defaulted from an acceptance-tests bar ref ─────────

test('an acceptance-tests bar with no --spec defaults state.test_command to the bar ref', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const testCommand = 'bun test ./relative/dir';
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'acceptance-tests', '--bar-ref', testCommand,
        '--repo-root', repoRoot, '--output-dir', outputDir],
      {
        runLoopFn: async () => {},
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.test_command).toBe(testCommand);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an explicit --spec test_command wins over an acceptance-tests bar ref', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const specPath = path.join(outputDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ test_command: 'bun test ./spec/dir' }));
  const barCommand = 'bun test ./relative/dir';
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'acceptance-tests', '--bar-ref', barCommand,
        '--spec', specPath, '--repo-root', repoRoot, '--output-dir', outputDir],
      {
        runLoopFn: async () => {},
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.test_command).toBe('bun test ./spec/dir');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a metric bar ref (a threshold descriptor) is never assigned to state.test_command', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const metricRef = 'coverage >= 0.8';
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'metric', '--bar-ref', metricRef,
        '--repo-root', repoRoot, '--output-dir', outputDir],
      {
        runLoopFn: async () => {},
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.test_command).toBe(null);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an external-reference bar ref (a filesystem path) is never assigned to state.test_command', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir],
      {
        runLoopFn: async () => {},
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.test_command).toBe(null);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
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
  const gateFile = path.join(outputDir, 'stub-gate.json');
  fs.writeFileSync(gateFile, '{}');
  let callCount = 0;
  let receivedState = null;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--gate', gateFile],
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

// ── FIX 1: --dry-run must not write state ────────────────────────────────

test('--dry-run with no --output-dir leaves no round_state.json or run directory under cwd (RED before fix, GREEN after)', () => {
  const repoRoot = makeTmpRepo();
  try {
    const res = childProcess.spawnSync('bun', [CLI, '--goal', 'do the thing',
      '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png', '--dry-run'],
      { encoding: 'utf8', cwd: repoRoot });
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, '.advisor-loop'))).toBe(false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── FIX 2: default gate ──────────────────────────────────────────────────

const DEFAULT_GATE_PATH = path.resolve(__dirname, '..', 'gates', 'advisor-default.json');

test('default gate path is recorded in round_state when --gate is omitted (asserts PATH only, not file contents)', async () => {
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
    expect(state.safety_gate_path).toBe(DEFAULT_GATE_PATH);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an explicit --gate overrides the default and is recorded in round_state', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const gateFile = path.join(outputDir, 'my-gate.json');
  fs.writeFileSync(gateFile, '{}');
  try {
    const code = await main(
      ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--gate', gateFile, '--dry-run'],
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.safety_gate_path).toBe(gateFile);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a missing --gate file produces a non-zero exit naming the expected path', async () => {
  const missingPath = path.join(os.tmpdir(), 'advisor-loop-does-not-exist-gate.json');
  const stderrChunks = [];
  const code = await main(
    ['--goal', 'do the thing', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
      '--gate', missingPath, '--dry-run'],
    { stdout: { write: () => {} }, stderr: { write: (s) => stderrChunks.push(s) } },
  );
  expect(code).not.toBe(0);
  expect(stderrChunks.join('')).toContain(missingPath);
});

// ── FIX 3: --task flag + strict flag allowlist ───────────────────────────

test('unrecognized flag exits 2 naming the offending flag', async () => {
  const stderrChunks = [];
  const code = await main(
    ['--goal', 'do the thing', '--taskk', 'oops', '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png'],
    { stdout: { write: () => {} }, stderr: { write: (s) => stderrChunks.push(s) } },
  );
  expect(code).toBe(2);
  expect(stderrChunks.join('')).toContain('--taskk');
});

test('--task text reaches the round-0 builder brief', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const gateFile = path.join(outputDir, 'stub-gate.json');
  fs.writeFileSync(gateFile, '{}');
  let receivedState = null;
  try {
    const code = await main(
      ['--goal', 'do the thing', '--task', 'OBJECTIVE: fix the widget\nSCOPE: widget.js only',
        '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--gate', gateFile],
      {
        runLoopFn: async (state) => { receivedState = state; },
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(receivedState.task).toBe('OBJECTIVE: fix the widget\nSCOPE: widget.js only');
    const { buildBuilderBrief } = require('../lib/loop-driver');
    const brief = buildBuilderBrief(receivedState, null, '/tmp/worktree');
    expect(brief.task).toContain('OBJECTIVE: fix the widget');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('round 1 brief contains both the original task text and the prior round gap', () => {
  const { buildBuilderBrief } = require('../lib/loop-driver');
  const state = { goal: 'do the thing', task: 'ORIGINAL BRIEF TEXT' };
  const priorRound = { single_biggest_gap: 'the gap from round one', files_changed: ['src/gap-file.js'], test_state: {} };
  const brief = buildBuilderBrief(state, priorRound, '/tmp/worktree');
  expect(brief.task).toContain('ORIGINAL BRIEF TEXT');
  expect(brief.task).toContain('the gap from round one');
});

// ── --agent wiring ────────────────────────────────────────────────────────

test('--agent <name> is persisted in round_state.json', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const gateFile = path.join(outputDir, 'stub-gate.json');
  fs.writeFileSync(gateFile, '{}');
  try {
    const code = await main(
      ['--goal', 'do the thing', '--agent', 'custom-builder',
        '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--gate', gateFile, '--dry-run'],
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.agent).toBe('custom-builder');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('--agent <name> reaches the builder brief produced by buildBuilderBrief', () => {
  const { buildBuilderBrief } = require('../lib/loop-driver');
  const state = { goal: 'do the thing', task: 'TASK TEXT', agent: 'custom-builder' };
  const brief = buildBuilderBrief(state, null, '/tmp/worktree');
  expect(brief.agent).toBe('custom-builder');
});

test('omitting --agent still yields coder in round_state.json and the builder brief', async () => {
  const { buildBuilderBrief } = require('../lib/loop-driver');
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const gateFile = path.join(outputDir, 'stub-gate.json');
  fs.writeFileSync(gateFile, '{}');
  try {
    const code = await main(
      ['--goal', 'do the thing',
        '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--gate', gateFile, '--dry-run'],
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'round_state.json'), 'utf8'));
    expect(state.agent).toBe('coder');
    const brief = buildBuilderBrief(state, null, '/tmp/worktree');
    expect(brief.agent).toBe('coder');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an unrecognized --agent name is not rejected by the CLI itself', async () => {
  const repoRoot = makeTmpRepo();
  const outputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'advisor-loop-out-'));
  const gateFile = path.join(outputDir, 'stub-gate.json');
  fs.writeFileSync(gateFile, '{}');
  try {
    const code = await main(
      ['--goal', 'do the thing', '--agent', 'totally-unknown-agent-xyz',
        '--bar-type', 'external-reference', '--bar-ref', '/tmp/ref.png',
        '--repo-root', repoRoot, '--output-dir', outputDir, '--gate', gateFile, '--dry-run'],
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
