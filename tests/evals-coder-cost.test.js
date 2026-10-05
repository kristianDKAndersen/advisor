import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawn, spawnSync } from 'child_process';

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-fixture-'));
const RESULTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-results-'));
const EVAL_FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-evaldir-'));
process.env.CODER_COST_REPO_ROOT = FIXTURE_ROOT;
process.env.CODER_COST_RESULTS_DIR = RESULTS_ROOT;
process.env.CODER_COST_CASES_FILE = path.join(EVAL_FIXTURE_DIR, 'cases.jsonl');
process.env.CODER_COST_CONFIGS_FILE = path.join(EVAL_FIXTURE_DIR, 'configs.json');
// Deterministic stand-in for ~/.claude/settings.json (real enabledPlugins vary
// machine to machine) so buildRunSettings' plugin-override output is stable.
const USER_SETTINGS_FIXTURE = path.join(EVAL_FIXTURE_DIR, 'user-settings.json');
fs.writeFileSync(USER_SETTINGS_FIXTURE, JSON.stringify({ enabledPlugins: { 'some-plugin': true, 'another-plugin': false } }));
process.env.CODER_COST_USER_SETTINGS_FILE = USER_SETTINGS_FIXTURE;

const runner = require('../evals/coder-cost/run.js');
const reporter = require('../evals/coder-cost/report.js');
const { priceForModel } = require('../bin/advisor-cost');

const RUN_JS_PATH = path.join(__dirname, '..', 'evals', 'coder-cost', 'run.js');

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

  fs.writeFileSync(path.join(EVAL_FIXTURE_DIR, 'cases.jsonl'), JSON.stringify({
    id: 'case-test', base_sha: baseSha, solution_sha: solutionSha,
    brief: 'fix add()', hidden_tests: ['tests/add.test.js'], timeout_sec: 60,
  }) + '\n');
  fs.writeFileSync(path.join(EVAL_FIXTURE_DIR, 'configs.json'), JSON.stringify({
    'sonnet5-medium': { model: 'claude-sonnet-5', effort: 'medium', time_aware: false },
    'sonnet5-medium-timeaware': { model: 'claude-sonnet-5', effort: 'medium', time_aware: true, append_system_prompt: 'go fast' },
  }));

  const stubSrc = [
    '#!/usr/bin/env bun',
    'const fs = require("fs");',
    'if (process.env.STUB_INVOKED_LOG) { try { fs.appendFileSync(process.env.STUB_INVOKED_LOG, process.pid + "\\n"); } catch (e) {} }',
    'const mode = process.env.STUB_MODE;',
    'function busySleep(ms) { const start = Date.now(); while (Date.now() - start < ms) {} }',
    'if (mode === "slow") { busySleep(5000); }',
    'if (mode === "track") {',
    '  fs.appendFileSync(process.env.STUB_LOG_FILE, JSON.stringify({ event: "start", ts: Date.now(), pid: process.pid }) + "\\n");',
    '  busySleep(1000);',
    '  fs.appendFileSync(process.env.STUB_LOG_FILE, JSON.stringify({ event: "end", ts: Date.now(), pid: process.pid }) + "\\n");',
    '}',
    'if (mode === "fix") { fs.writeFileSync("lib/add.js", process.env.STUB_FIX_CONTENT); }',
    'if (mode === "wrongfix") { fs.writeFileSync("lib/add.js", "function add(a, b) { return a + b + 1; }\\nmodule.exports = { add };\\n"); }',
    'if (mode === "badjson") { process.stdout.write("not json"); process.exit(0); }',
    'if (mode === "inspect") {',
    '  let claudeMd = null;',
    '  try { claudeMd = fs.readFileSync("CLAUDE.md", "utf8"); } catch (e) {}',
    '  const argv = process.argv.slice(2);',
    '  const settingsIdx = argv.indexOf("--settings");',
    '  let settingsContent = null;',
    '  if (settingsIdx !== -1) { try { settingsContent = fs.readFileSync(argv[settingsIdx + 1], "utf8"); } catch (e) {} }',
    '  fs.writeFileSync(process.env.STUB_LOG_FILE, JSON.stringify({ argv, claudeMd, hasDotClaude: fs.existsSync(".claude"), settingsContent }));',
    '}',
    'if (mode === "evil") { require("child_process").spawnSync("git", ["branch", "evil"]); }',
    'process.stdout.write(JSON.stringify({ total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 50 }, session_id: "stub-session", num_turns: 3 }));',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(STUB_CLAUDE_PATH, stubSrc);
  fs.chmodSync(STUB_CLAUDE_PATH, 0o755);
});

afterAll(() => {
  for (const d of [FIXTURE_ROOT, RESULTS_ROOT, STUB_DIR, EVAL_FIXTURE_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  }
});

async function withStubPath(fn) {
  const origPath = process.env.PATH;
  process.env.PATH = `${STUB_DIR}:${origPath}`;
  try { return await fn(); } finally { process.env.PATH = origPath; }
}

function makeCase(timeoutSec = 60) {
  return {
    id: 'case-test', base_sha: baseSha, solution_sha: solutionSha,
    brief: 'fix add()', hidden_tests: ['tests/add.test.js'], timeout_sec: timeoutSec,
  };
}

const cfg = { model: 'claude-sonnet-5', effort: 'medium' };

function runCli(args, env = {}) {
  return spawnSync('bun', [RUN_JS_PATH, ...args], {
    cwd: FIXTURE_ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, ...env },
  });
}

describe('outcome classification (stubbed claude binary)', () => {
  test('pass: agent fixes the file, hidden tests pass', async () => {
    process.env.STUB_MODE = 'fix';
    process.env.STUB_FIX_CONTENT = RIGHT_IMPL;
    const result = await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 1));
    expect(result.outcome).toBe('pass');
    expect(result.cost_instrument_a.cost).toBeCloseTo(0.0123, 5);
  });

  test('no_attempt: agent makes zero worktree changes, distinct from a genuine failed attempt', async () => {
    process.env.STUB_MODE = 'nofix';
    const result = await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 2));
    expect(result.outcome).toBe('no_attempt');
    expect(result.checker_exit_code).toBeUndefined();
    expect(result.session_id).toBe('stub-session');
    expect(result.num_turns).toBe(3);
    expect(result.claude_exit_code).toBe(0);
    expect(result.cost_instrument_a.cost).toBeCloseTo(0.0123, 5);
  });

  test('fail: agent attempts a fix but gets it wrong, hidden tests fail, and the record carries checker_output_tail', async () => {
    process.env.STUB_MODE = 'wrongfix';
    const result = await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 2.5));
    expect(result.outcome).toBe('fail');
    expect(result.checker_exit_code).not.toBe(0);
    expect(typeof result.checker_output_tail).toBe('string');
    expect(result.checker_output_tail.length).toBeGreaterThan(0);
    expect(result.session_id).toBe('stub-session');
    expect(result.num_turns).toBe(3);
    expect(result.claude_exit_code).toBe(0);
  });

  test('error: agent produces unparseable stdout', async () => {
    process.env.STUB_MODE = 'badjson';
    const result = await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 3));
    expect(result.outcome).toBe('error');
  });

  test('timeout: agent exceeds the case wall-clock budget', async () => {
    process.env.STUB_MODE = 'slow';
    const result = await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(1), 4));
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

describe('costFromTranscript (priced via bin/advisor-cost)', () => {
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

    const result = runner.costFromTranscript('sess-abc', 'claude-sonnet-5', projectsRoot);
    const rate = priceForModel('claude-sonnet-5');
    const expectedInput = 1500, expectedOutput = 300;
    const expectedCost = (expectedInput / 1e6) * rate.input + (expectedOutput / 1e6) * rate.output;
    expect(result.tokens).toEqual({ input: expectedInput, output: expectedOutput, cacheRead: 0, cache5m: 0, cache1h: 0 });
    expect(result.cost).toBeCloseTo(expectedCost, 8);
  });

  test('includes advisor_message iterations from usage.iterations, priced at their own model', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-projects-advisor-'));
    const projDir = path.join(projectsRoot, 'slug');
    fs.mkdirSync(projDir, { recursive: true });
    const lines = [{
      message: {
        id: 'm1', model: 'claude-sonnet-5',
        usage: {
          input_tokens: 1000, output_tokens: 200,
          iterations: [{ type: 'advisor_message', model: 'claude-opus-5', input_tokens: 500, output_tokens: 100 }],
        },
      },
    }];
    fs.writeFileSync(path.join(projDir, 'sess-advisor.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const result = runner.costFromTranscript('sess-advisor', 'claude-sonnet-5', projectsRoot);
    const sonnetRate = priceForModel('claude-sonnet-5');
    const opusRate = priceForModel('claude-opus-5');
    const expectedCost = (1000 / 1e6) * sonnetRate.input + (200 / 1e6) * sonnetRate.output
      + (500 / 1e6) * opusRate.input + (100 / 1e6) * opusRate.output;
    expect(result.cost).toBeCloseTo(expectedCost, 10);
  });

  test('reports unavailable (not a silent zero) when no transcript matches', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-projects-empty-'));
    const result = runner.costFromTranscript('missing-session', 'claude-sonnet-5', projectsRoot);
    expect(result.cost).toBeNull();
    expect(result.note).toMatch(/no transcript found/);
  });

  test('splits usage.cache_creation into ephemeral 5m/1h tiers, each priced at its own rate', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-projects-cache-'));
    const projDir = path.join(projectsRoot, 'slug');
    fs.mkdirSync(projDir, { recursive: true });
    const lines = [{
      message: {
        id: 'm1', model: 'claude-sonnet-5',
        usage: {
          input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
        },
      },
    }];
    fs.writeFileSync(path.join(projDir, 'sess-cache.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const result = runner.costFromTranscript('sess-cache', 'claude-sonnet-5', projectsRoot);
    const rate = priceForModel('claude-sonnet-5');
    const expectedCost = (1000 / 1e6) * rate.input + (200 / 1e6) * rate.output + (500 / 1e6) * rate.cache_read
      + (2000 / 1e6) * rate.cache_creation + (1000 / 1e6) * rate.cache_write_1h;
    expect(result.tokens).toEqual({ input: 1000, output: 200, cacheRead: 500, cache5m: 2000, cache1h: 1000 });
    expect(result.cost).toBeCloseTo(expectedCost, 10);
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
  // Historical premise ("scales with brief length") no longer holds: with no history,
  // estimateRunCost now uses a fixed multi-turn token model keyed by effort, not brief size.
  test('estimateRunCost with no history falls back to the model and uses bin/advisor-cost rates', () => {
    const kase = { id: 'case-test', brief: 'x'.repeat(4000), timeout_sec: 600 };
    const est = runner.estimateRunCost(kase, cfg);
    expect(est.cost).toBeGreaterThan(0);
    expect(est.source).toBe('model');
  });

  test('parseArgs reads --configs, --cases, --trials, --concurrency, --dry-run, --confirm', () => {
    const args = runner.parseArgs(['--configs', 'a,b', '--cases', 'case-001', '--trials', '3', '--concurrency', '4', '--dry-run', '--confirm']);
    expect(args.configs).toEqual(['a', 'b']);
    expect(args.cases).toEqual(['case-001']);
    expect(args.trials).toBe(3);
    expect(args.concurrency).toBe(4);
    expect(args.dryRun).toBe(true);
    expect(args.confirm).toBe(true);
    expect(args.unknown).toEqual([]);
  });

  test('parseArgs collects unrecognized flags for the caller to reject', () => {
    const args = runner.parseArgs(['--bogus']);
    expect(args.unknown).toEqual(['--bogus']);
  });
});

describe('cost estimation: history vs fallback (red/green: evals/coder-cost/run.js)', () => {
  test('loadHistory: uses cost_instrument_b.cost, falls back to cost_instrument_a.cost, skips _invalid dirs / no_attempt / <=3-turn rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-history-'));
    const sub = path.join(dir, 'batch1');
    const invalidSub = path.join(dir, '_invalid-batch');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(invalidSub, { recursive: true });
    const rows = [
      { config: 'c1', case_id: 'case-a', outcome: 'pass', num_turns: 10, cost_instrument_b: { cost: 1.0 } },
      { config: 'c1', case_id: 'case-a', outcome: 'pass', num_turns: 12, cost_instrument_a: { cost: 2.0 } }, // no instrument_b -> falls back to A
      { config: 'c1', case_id: 'case-b', outcome: 'no_attempt', num_turns: 10, cost_instrument_b: { cost: 99 } }, // excluded
      { config: 'c1', case_id: 'case-b', outcome: 'pass', num_turns: 2, cost_instrument_b: { cost: 99 } }, // excluded (<=3 turns)
      { config: 'c1', case_id: 'case-b', outcome: 'timeout', cost_instrument_b: { cost: 3.0 } }, // no num_turns, timeout counts
    ];
    fs.writeFileSync(path.join(dir, 'top.jsonl'), rows.slice(0, 1).map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(sub, 'batch.jsonl'), rows.slice(1).map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(invalidSub, 'batch.jsonl'), JSON.stringify({ config: 'c1', case_id: 'case-z', outcome: 'pass', num_turns: 10, cost_instrument_b: { cost: 1000 } }) + '\n');

    const history = runner.loadHistory(dir);
    expect(history.c1.map((r) => r.cost).sort((a, b) => a - b)).toEqual([1.0, 2.0, 3.0]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('CODER_COST_HISTORY_FILES adds extra history files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-history-env-'));
    const extra = path.join(dir, 'extra.jsonl');
    fs.writeFileSync(extra, JSON.stringify({ config: 'c2', case_id: 'case-x', outcome: 'pass', num_turns: 10, cost_instrument_b: { cost: 5.0 } }) + '\n');
    const origEnv = process.env.CODER_COST_HISTORY_FILES;
    process.env.CODER_COST_HISTORY_FILES = extra;
    const history = runner.loadHistory(path.join(dir, 'nonexistent-results'));
    expect(history.c2.map((r) => r.cost)).toEqual([5.0]);
    if (origEnv === undefined) delete process.env.CODER_COST_HISTORY_FILES; else process.env.CODER_COST_HISTORY_FILES = origEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('historyEstimate prefers same-case rows over the config-wide mean', () => {
    const history = {
      c1: [
        { cost: 1.0, case_id: 'case-a' },
        { cost: 3.0, case_id: 'case-a' },
        { cost: 100.0, case_id: 'case-b' },
      ],
    };
    const est = runner.historyEstimate(history, 'c1', 'case-a');
    expect(est.cost).toBe(2.0);
    expect(est.n).toBe(2);
  });

  test('historyEstimate falls back to the full config mean when no same-case rows exist', () => {
    const history = { c1: [{ cost: 1.0, case_id: 'case-a' }, { cost: 3.0, case_id: 'case-a' }] };
    const est = runner.historyEstimate(history, 'c1', 'case-unseen');
    expect(est.cost).toBe(2.0);
    expect(est.n).toBe(2);
  });

  test('estimateRunCost prefers history over the fallback model when history exists for the config', () => {
    const history = { 'sonnet5-medium': [{ cost: 1.25, case_id: 'case-test' }] };
    const est = runner.estimateRunCost({ id: 'case-test' }, cfg, 'sonnet5-medium', history);
    expect(est.cost).toBe(1.25);
    expect(est.source).toBe('history n=1');
  });

  test('estimateRunCost falls back to the model when the config has no history rows', () => {
    const est = runner.estimateRunCost({ id: 'case-test' }, cfg, 'sonnet5-medium', {});
    expect(est.source).toBe('model');
    expect(est.cost).toBeGreaterThan(0);
  });

  // Measured means from calibration data (matrixA1-truncated-briefs.jsonl / smoke3.jsonl,
  // >3-turn rows only): sonnet5-medium/medium ~$1.25/run (n=16), opus55-low/low ~$0.57/run (n=11).
  const CALIBRATION_MEANS = { 'claude-sonnet-5:medium': 1.25, 'claude-opus-5-5:low': 0.57 };

  test('fallback model lands within 30% of the measured calibration means', () => {
    const sonnetMedium = runner.computeFallbackCost({ model: 'claude-sonnet-5', effort: 'medium' });
    const opusLow = runner.computeFallbackCost({ model: 'claude-opus-5-5', effort: 'low' });
    expect(Math.abs(sonnetMedium - CALIBRATION_MEANS['claude-sonnet-5:medium']) / CALIBRATION_MEANS['claude-sonnet-5:medium']).toBeLessThan(0.3);
    expect(Math.abs(opusLow - CALIBRATION_MEANS['claude-opus-5-5:low']) / CALIBRATION_MEANS['claude-opus-5-5:low']).toBeLessThan(0.3);
  });

  test('fallback model cost is monotone in effort (low < medium < high) for both models', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5-5']) {
      const low = runner.computeFallbackCost({ model, effort: 'low' });
      const medium = runner.computeFallbackCost({ model, effort: 'medium' });
      const high = runner.computeFallbackCost({ model, effort: 'high' });
      expect(low).toBeLessThan(medium);
      expect(medium).toBeLessThan(high);
    }
  });

  test('buildPlan dry-run totals: history-backed configs use history, others use the fallback model, p90 total is at least the mean total', () => {
    const history = {
      'sonnet5-medium': [{ cost: 1.25, case_id: 'case-a' }, { cost: 1.0, case_id: 'case-b' }],
    };
    const allConfigs = {
      'sonnet5-medium': { model: 'claude-sonnet-5', effort: 'medium' },
      'sonnet5-high': { model: 'claude-sonnet-5', effort: 'high' },
    };
    const cases = [{ id: 'case-a' }, { id: 'case-b' }];
    const plan = runner.buildPlan(['sonnet5-medium', 'sonnet5-high'], allConfigs, cases, 1, history);
    const historyRows = plan.rows.filter((r) => r.config === 'sonnet5-medium');
    const fallbackRows = plan.rows.filter((r) => r.config === 'sonnet5-high');
    expect(historyRows.every((r) => r.source.startsWith('history'))).toBe(true);
    expect(fallbackRows.every((r) => r.source === 'model')).toBe(true);
    expect(plan.total).toBeGreaterThan(0);
    expect(plan.p90Total).toBeGreaterThanOrEqual(plan.total * 0.9);
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

describe('buildRunSettings', () => {
  test('always writes merged settings with plugin overrides, plus the elapsed-time hook for time_aware configs', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-wt-'));
    const settingsPath = runner.buildRunSettings(wt, { time_aware: true });
    expect(settingsPath).toBe(path.join(wt, '.coder-cost-settings.json'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.enabledPlugins).toEqual({ 'some-plugin': false });
    expect(Object.keys(settings.hooks)).toEqual(['PostToolUse']);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('elapsed-time-hook.js');
    fs.rmSync(wt, { recursive: true, force: true });
  });

  test('omits hooks for non time-aware configs but still writes the plugin overrides', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-wt2-'));
    const settingsPath = runner.buildRunSettings(wt, { time_aware: false });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.enabledPlugins).toEqual({ 'some-plugin': false });
    expect(settings.hooks).toBeUndefined();
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe('setupNeutralWorkspace', () => {
  test('strips claude.md/.claude and writes the exact neutral CLAUDE.md text', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-neutral-'));
    fs.writeFileSync(path.join(wt, 'CLAUDE.md'), '# Advisor doctrine: delegate everything');
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), '{}');
    runner.setupNeutralWorkspace(wt);
    expect(fs.existsSync(path.join(wt, '.claude'))).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8').trim()).toBe(runner.NEUTRAL_CLAUDE_MD);
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe('isolation (clone-based, not git worktree)', () => {
  test('the clone has no claude.md/.claude and the neutral CLAUDE.md, and the stub receives --setting-sources user, --disallowedTools and the merged --settings', async () => {
    const logFile = path.join(EVAL_FIXTURE_DIR, 'inspect.log');
    process.env.STUB_MODE = 'inspect';
    process.env.STUB_LOG_FILE = logFile;
    const result = await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 10));
    expect(result.outcome).toBe('no_attempt'); // 'inspect' mode never touches lib/add.js
    const seen = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    expect(seen.claudeMd.trim()).toBe(runner.NEUTRAL_CLAUDE_MD);
    expect(seen.hasDotClaude).toBe(false);
    expect(seen.argv).toContain('--setting-sources');
    expect(seen.argv[seen.argv.indexOf('--setting-sources') + 1]).toBe('user');
    expect(seen.argv).toContain('--disallowedTools');
    expect(seen.argv[seen.argv.indexOf('--disallowedTools') + 1]).toBe(runner.EVAL_DISALLOWED_TOOLS.join(','));
    expect(seen.argv).toContain('--settings');
    const settings = JSON.parse(seen.settingsContent);
    expect(settings.enabledPlugins).toEqual({ 'some-plugin': false });
  });

  test("the clone's refs are independent: a stub that runs `git branch evil` in its cwd leaves no evil branch in the source repo", async () => {
    process.env.STUB_MODE = 'evil';
    await withStubPath(() => runner.runOne('sonnet5-medium', cfg, makeCase(), 11));
    const branches = execSync('git branch --list evil', { cwd: FIXTURE_ROOT }).toString().trim();
    expect(branches).toBe('');
  });
});

describe('spend guard (CLI)', () => {
  test('--help prints usage, exits 0, and never invokes the claude stub', () => {
    const invokedLog = path.join(EVAL_FIXTURE_DIR, 'invoked-help.log');
    const res = runCli(['--help'], { STUB_INVOKED_LOG: invokedLog });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
    expect(fs.existsSync(invokedLog)).toBe(false);
  });

  test('missing --confirm prints the dry-run plan, exits 3, and never invokes the claude stub', () => {
    const invokedLog = path.join(EVAL_FIXTURE_DIR, 'invoked-noconfirm.log');
    const res = runCli(['--configs', 'sonnet5-medium', '--cases', 'case-test'], { STUB_INVOKED_LOG: invokedLog });
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('DRY RUN plan');
    expect(fs.existsSync(invokedLog)).toBe(false);
  });

  test('unknown flag exits 2', () => {
    const res = runCli(['--bogus']);
    expect(res.status).toBe(2);
  });
});

describe('worktree cleanup on SIGTERM', () => {
  test('a mid-run SIGTERM removes the worktree instead of leaking it', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('coder-cost-')));
    const child = spawn('bun', [RUN_JS_PATH, '--configs', 'sonnet5-medium', '--cases', 'case-test', '--trials', '1', '--concurrency', '1', '--confirm'], {
      cwd: FIXTURE_ROOT,
      env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, STUB_MODE: 'slow' },
    });
    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('coder-cost-') && !before.has(n));
    expect(after.length).toBe(0);
  }, 20000);
});

describe('build-briefs.js (real cases.jsonl, real repo history)', () => {
  const buildBriefs = require('../evals/coder-cost/build-briefs.js');
  const REAL_REPO_ROOT = path.join(__dirname, '..');
  const realCases = fs.readFileSync(path.join(REAL_REPO_ROOT, 'evals', 'coder-cost', 'cases.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  test('every case brief has 26 entries to check', () => {
    expect(realCases.length).toBe(26);
  });

  for (const kase of realCases) {
    test(`${kase.id}: brief carries the preamble and the full, untruncated solution-commit message`, () => {
      expect(kase.brief.startsWith(buildBriefs.PREAMBLE)).toBe(true);
      const expectedMessage = buildBriefs.stripTrailers(
        execSync(`git log -1 --format=%B ${kase.solution_sha}`, { cwd: REAL_REPO_ROOT, encoding: 'utf8' }).replace(/\n$/, '')
      );
      const actualMessage = kase.brief.slice(buildBriefs.PREAMBLE.length);
      expect(actualMessage).toBe(expectedMessage);
      const subjectLine = expectedMessage.split('\n')[0];
      expect(actualMessage).toContain(subjectLine);
      // Not a prefix-truncation: the real message's last line must appear in full.
      const expectedLastLine = expectedMessage.split('\n').filter(Boolean).pop();
      expect(actualMessage).toContain(expectedLastLine);
    });
  }
});

describe('report.js renders no_attempt', () => {
  test('no_attempt gets its own counted column, separate from fail/pass', () => {
    const results = [
      { config: 'c1', outcome: 'pass', cost_instrument_a: { cost: 1.0 } },
      { config: 'c1', outcome: 'no_attempt', cost_instrument_a: { cost: 0.2 } },
      { config: 'c1', outcome: 'no_attempt', cost_instrument_a: { cost: 0.2 } },
    ];
    const md = reporter.buildReport(results);
    expect(md).toContain('no_attempt');
    const row = md.split('\n').find((l) => l.startsWith('| c1 |'));
    const cells = row.split('|').map((c) => c.trim());
    // cells: ['', config, runs, pass, fail, timeout, error, no_attempt, ...]
    expect(cells[7]).toBe('2'); // no_attempt count
    expect(cells[3]).toBe('1'); // pass count unaffected
  });
});

describe('real concurrency', () => {
  test('--concurrency 3 runs 3 jobs with overlapping execution windows and writes all 3 results', () => {
    const logFile = path.join(EVAL_FIXTURE_DIR, 'concurrency.log');
    fs.writeFileSync(logFile, '');
    const beforeFiles = new Set(fs.readdirSync(RESULTS_ROOT));
    const res = runCli(['--configs', 'sonnet5-medium', '--cases', 'case-test', '--trials', '3', '--concurrency', '3', '--confirm'],
      { STUB_MODE: 'track', STUB_LOG_FILE: logFile });
    expect(res.status).toBe(0);

    const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const starts = events.filter((e) => e.event === 'start').sort((a, b) => a.ts - b.ts);
    const ends = events.filter((e) => e.event === 'end').sort((a, b) => a.ts - b.ts);
    expect(starts.length).toBe(3);
    expect(ends.length).toBe(3);
    // Real concurrency: at least 2 jobs must have started before the first one ended.
    const startsBeforeFirstEnd = starts.filter((s) => s.ts <= ends[0].ts).length;
    expect(startsBeforeFirstEnd).toBeGreaterThanOrEqual(2);

    const newFile = [...fs.readdirSync(RESULTS_ROOT)].find((f) => !beforeFiles.has(f));
    expect(newFile).toBeDefined();
    const lines = fs.readFileSync(path.join(RESULTS_ROOT, newFile), 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
  }, 30000);
});
