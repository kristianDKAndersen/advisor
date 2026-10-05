import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-fixture-'));
const RESULTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-results-'));
process.env.CODER_COST_REPO_ROOT = FIXTURE_ROOT;
process.env.CODER_COST_RESULTS_DIR = RESULTS_ROOT;

const runner = require('../evals/coder-cost/run.js');
const reporter = require('../evals/coder-cost/report.js');

const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-stub-'));
const STUB_CLAUDE_PATH = path.join(STUB_DIR, 'claude');

const WRONG_IMPL = 'function add(a, b) { return a + b - 1; }\nmodule.exports = { add };\n';
const RIGHT_IMPL = 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n';
const HIDDEN_TEST = [
  'import { test, expect } from "bun:test";',
  'const { add } = require("../lib/add.js");',
  'test("adds", () => { expect(add(2, 3)).toBe(5); });',
  '',
].join('\n');

let baseSha, solutionSha;

beforeAll(() => {
  execSync('git init -q', { cwd: FIXTURE_ROOT });
  execSync('git config user.email test@example.com', { cwd: FIXTURE_ROOT });
  execSync('git config user.name test', { cwd: FIXTURE_ROOT });
  fs.mkdirSync(path.join(FIXTURE_ROOT, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE_ROOT, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_ROOT, 'lib', 'add.js'), WRONG_IMPL);
  execSync('git add -A && git commit -q -m base', { cwd: FIXTURE_ROOT });
  baseSha = execSync('git rev-parse HEAD', { cwd: FIXTURE_ROOT }).toString().trim();

  fs.writeFileSync(path.join(FIXTURE_ROOT, 'lib', 'add.js'), RIGHT_IMPL);
  fs.writeFileSync(path.join(FIXTURE_ROOT, 'tests', 'add.test.js'), HIDDEN_TEST);
  execSync('git add -A && git commit -q -m solution', { cwd: FIXTURE_ROOT });
  solutionSha = execSync('git rev-parse HEAD', { cwd: FIXTURE_ROOT }).toString().trim();

  const stubSrc = [
    '#!/usr/bin/env bun',
    'const fs = require("fs");',
    'const mode = process.env.STUB_MODE;',
    'if (mode === "slow") { execSleep(); }',
    'function execSleep() { const start = Date.now(); while (Date.now() - start < 5000) {} }',
    'if (mode === "fix") { fs.writeFileSync("lib/add.js", process.env.STUB_FIX_CONTENT); }',
    'if (mode === "badjson") { process.stdout.write("not json"); process.exit(0); }',
    'process.stdout.write(JSON.stringify({ total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 50 }, session_id: "stub-session" }));',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(STUB_CLAUDE_PATH, stubSrc);
  fs.chmodSync(STUB_CLAUDE_PATH, 0o755);
});

afterAll(() => {
  for (const d of [FIXTURE_ROOT, RESULTS_ROOT, STUB_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  }
});

function withStubPath(fn) {
  const origPath = process.env.PATH;
  process.env.PATH = `${STUB_DIR}:${origPath}`;
  try { return fn(); } finally { process.env.PATH = origPath; }
}

function makeCase(timeoutSec = 60) {
  return {
    id: 'case-test', base_sha: baseSha, solution_sha: solutionSha,
    brief: 'fix add()', hidden_tests: ['tests/add.test.js'], timeout_sec: timeoutSec,
  };
}

const cfg = { model: 'claude-sonnet-5', effort: 'medium' };
const rates = { verified: false, models: { 'claude-sonnet-5': { input_per_mtok: 3, output_per_mtok: 15, cache_write_per_mtok: 3.75, cache_read_per_mtok: 0.3 } } };

describe('outcome classification (stubbed claude binary)', () => {
  test('pass: agent fixes the file, hidden tests pass', () => {
    process.env.STUB_MODE = 'fix';
    process.env.STUB_FIX_CONTENT = RIGHT_IMPL;
    const result = withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 1, rates));
    expect(result.outcome).toBe('pass');
    expect(result.cost_instrument_a.cost).toBeCloseTo(0.0123, 5);
  });

  test('fail: agent does not fix the file, hidden tests fail', () => {
    process.env.STUB_MODE = 'nofix';
    const result = withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 2, rates));
    expect(result.outcome).toBe('fail');
  });

  test('error: agent produces unparseable stdout', () => {
    process.env.STUB_MODE = 'badjson';
    const result = withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 3, rates));
    expect(result.outcome).toBe('error');
  });

  test('timeout: agent exceeds the case wall-clock budget', () => {
    process.env.STUB_MODE = 'slow';
    const result = withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(1), 4, rates));
    expect(result.outcome).toBe('timeout');
  }, 15000);
});

describe('resume / skip', () => {
  test('loadCompletedSet reflects previously written result files, and completedKey matches', () => {
    fs.mkdirSync(RESULTS_ROOT, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_ROOT, 'run-1.jsonl'), JSON.stringify({ config: 'sonnet5-medium', case_id: 'case-001', trial: 1, outcome: 'pass' }) + '\n');
    const done = runner.loadCompletedSet();
    expect(done.has(runner.completedKey('sonnet5-medium', 'case-001', 1))).toBe(true);
    expect(done.has(runner.completedKey('sonnet5-medium', 'case-002', 1))).toBe(false);
  });
});

describe('instrument-disagreement flag', () => {
  test('flags when instrument A and B differ by more than 5%', () => {
    const d = runner.disagreement(1.0, 0.9);
    expect(d.flag).toBe(true);
    expect(d.reason).toBe('cost_mismatch');
  });

  test('does not flag when instruments agree within 5%', () => {
    const d = runner.disagreement(1.0, 0.98);
    expect(d.flag).toBe(false);
    expect(d.reason).toBeNull();
  });

  test('flags a missing instrument B rather than silently treating it as agreement', () => {
    const d = runner.disagreement(1.0, null);
    expect(d.flag).toBe(true);
    expect(d.reason).toBe('instrument_b_missing');
  });
});

describe('costFromTranscript', () => {
  test('finds the transcript by scanning <projectsRoot>/*/<session_id>.jsonl and dedupes by message.id', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-projects-'));
    const projDir = path.join(projectsRoot, 'some-project-slug');
    fs.mkdirSync(projDir, { recursive: true });
    const lines = [
      { message: { id: 'm1', usage: { input_tokens: 1000, output_tokens: 200 } } },
      { message: { id: 'm1', usage: { input_tokens: 1000, output_tokens: 200 } } }, // duplicate, must not double-count
      { message: { id: 'm2', usage: { input_tokens: 500, output_tokens: 100 } } },
    ];
    fs.writeFileSync(path.join(projDir, 'sess-abc.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const result = runner.costFromTranscript('sess-abc', rates, 'claude-sonnet-5', projectsRoot);
    const expectedInput = 1500, expectedOutput = 300;
    const expectedCost = (expectedInput / 1e6) * 3 + (expectedOutput / 1e6) * 15;
    expect(result.tokens).toEqual({ input: expectedInput, output: expectedOutput, cacheWrite: 0, cacheRead: 0 });
    expect(result.cost).toBeCloseTo(expectedCost, 8);
  });

  test('reports unavailable (not a silent zero) when no transcript matches', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-projects-empty-'));
    const result = runner.costFromTranscript('missing-session', rates, 'claude-sonnet-5', projectsRoot);
    expect(result.cost).toBeNull();
    expect(result.note).toMatch(/no transcript found/);
  });
});

describe('cost-per-solved-task math (report.js)', () => {
  test('averages cost only over pass outcomes, not all runs', () => {
    const results = [
      { config: 'c1', outcome: 'pass', cost_instrument_a: { cost: 1.0 } },
      { config: 'c1', outcome: 'pass', cost_instrument_a: { cost: 3.0 } },
      { config: 'c1', outcome: 'fail', cost_instrument_a: { cost: 100.0 } },
    ];
    const md = reporter.buildReport(results);
    expect(md).toContain('$2.0000'); // cost/solved task = (1.0 + 3.0) / 2, excludes the 100.0 fail
  });

  test('costOf falls back to instrument B when A is unavailable', () => {
    expect(reporter.costOf({ cost_instrument_a: null, cost_instrument_b: { cost: 0.5 } })).toBe(0.5);
  });
});

describe('estimateRunCost / parseArgs', () => {
  test('estimateRunCost scales with brief length and uses the model rate table', () => {
    const kase = { brief: 'x'.repeat(4000), timeout_sec: 600 };
    const est = runner.estimateRunCost(kase, cfg, rates);
    expect(est.cost).toBeGreaterThan(0);
  });

  test('parseArgs reads --configs, --cases, --trials, --concurrency, --dry-run', () => {
    const args = runner.parseArgs(['--configs', 'a,b', '--cases', 'case-001', '--trials', '3', '--concurrency', '4', '--dry-run']);
    expect(args.configs).toEqual(['a', 'b']);
    expect(args.cases).toEqual(['case-001']);
    expect(args.trials).toBe(3);
    expect(args.concurrency).toBe(4);
    expect(args.dryRun).toBe(true);
  });
});

describe('env scrubbing', () => {
  test('scrubEnv removes session/runner-identifying vars', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'should-not-leak';
    const env = runner.scrubEnv();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
});
