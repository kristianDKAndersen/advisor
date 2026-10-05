#!/usr/bin/env bun
'use strict';
/*
 * Frozen, re-runnable eval runner for coder-worker cost/pass-rate comparison.
 * See README.md for full usage. Resumable: re-running skips any
 * (config, case, trial) tuple already present in evals/coder-cost/results/*.jsonl.
 *
 * Spend guard: no real `claude` invocation happens without --confirm. Without
 * it (or with --dry-run), the plan + estimate print and the process exits 3.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { priceForModel } = require('../../bin/advisor-cost');

const EVAL_DIR = __dirname;
// Overridable so the test suite can point these at disposable fixtures instead of this repo.
const REPO_ROOT = process.env.CODER_COST_REPO_ROOT || path.resolve(EVAL_DIR, '..', '..');
const RESULTS_DIR = process.env.CODER_COST_RESULTS_DIR || path.join(EVAL_DIR, 'results');
const MAX_CONCURRENCY = 6;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

// Overridable (like REPO_ROOT/RESULTS_DIR above) so tests can point the CLI at
// fixture cases/configs instead of this repo's real, real-money case list.
const CASES_FILE = process.env.CODER_COST_CASES_FILE || path.join(EVAL_DIR, 'cases.jsonl');
const CONFIGS_FILE = process.env.CODER_COST_CONFIGS_FILE || path.join(EVAL_DIR, 'configs.json');

function loadCases() {
  return readJsonl(CASES_FILE);
}

function loadConfigs() {
  return JSON.parse(fs.readFileSync(CONFIGS_FILE, 'utf8'));
}

const KNOWN_FLAGS = new Set(['--configs', '--cases', '--trials', '--concurrency', '--dry-run', '--confirm', '--help', '-h']);

function parseArgs(argv) {
  const args = { trials: 1, concurrency: 2, dryRun: false, configs: null, cases: null, confirm: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--confirm') { args.confirm = true; continue; }
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--configs') { args.configs = (argv[++i] || '').split(','); continue; }
    if (a === '--cases') { args.cases = (argv[++i] || '').split(','); continue; }
    if (a === '--trials') { args.trials = Number(argv[++i]); continue; }
    if (a === '--concurrency') { args.concurrency = Number(argv[++i]); continue; }
    args.unknown.push(a);
  }
  return args;
}

function printUsage() {
  console.log(`Usage: bun run.js [options]

Options:
  --configs <a,b,...>   Config names from configs.json (default: all)
  --cases <a,b,...|all> Case ids from cases.jsonl (default: all)
  --trials N            Trials per (config, case) pair (default: 1)
  --concurrency N       Parallel jobs, 1-${MAX_CONCURRENCY} (default: 2)
  --confirm             Required to actually invoke claude and spend money.
  --dry-run             Print the plan and cost estimate; never invokes claude.
  --help, -h            Show this help and exit.

Without --confirm (or with --dry-run), the plan + estimate are printed and
the process exits 3 without creating worktrees or invoking claude.`);
}

function completedKey(configName, caseId, trial) {
  return `${configName}|${caseId}|${trial}`;
}

function loadCompletedSet() {
  const done = new Set();
  if (!fs.existsSync(RESULTS_DIR)) return done;
  for (const f of fs.readdirSync(RESULTS_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const rec of readJsonl(path.join(RESULTS_DIR, f))) {
      if (rec && rec.config && rec.case_id && rec.trial != null) {
        done.add(completedKey(rec.config, rec.case_id, rec.trial));
      }
    }
  }
  return done;
}

// --- cost estimation (dry-run only; rough order-of-magnitude, NOT a billing figure) ---
function estimateRunCost(kase, cfg) {
  const BASE_CONTEXT_TOKENS = 15000; // repo/tooling overhead, heuristic
  const inputTokens = BASE_CONTEXT_TOKENS + Math.ceil((kase.brief || '').length / 4);
  const outputTokens = Math.min(20000, Math.max(1500, Math.round((kase.timeout_sec || 600) * 6)));
  const rate = priceForModel(cfg.model);
  const cost = (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output;
  return { inputTokens, outputTokens, cost };
}

function buildPlan(configNames, allConfigs, cases, trials) {
  const rows = [];
  let total = 0;
  for (const cn of configNames) {
    const cfg = allConfigs[cn];
    if (!cfg) { console.error(`unknown config: ${cn}`); continue; }
    for (const kase of cases) {
      for (let t = 1; t <= trials; t++) {
        const est = estimateRunCost(kase, cfg);
        total += est.cost;
        rows.push({ config: cn, case: kase.id, trial: t, est_cost_usd: Number(est.cost.toFixed(4)) });
      }
    }
  }
  return { rows, total };
}

function printDryRunPlan(plan, configNames, cases, trials) {
  console.log(`DRY RUN plan: ${plan.rows.length} runs across ${configNames.length} configs x ${cases.length} cases x ${trials} trial(s)`);
  console.log(`Estimated total notional spend: $${plan.total.toFixed(2)} (rough order-of-magnitude, priced via bin/advisor-cost rates)`);
  console.log(JSON.stringify(plan.rows, null, 2));
}

function scrubEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'SSE_PORT', 'CHILD_SESSION', 'ENTRYPOINT', 'CLAUDECODE']) {
    delete env[k];
  }
  return env;
}

// Tracks worktrees currently checked out so a terminating signal can remove them all.
const activeWorktrees = new Set();

function makeWorktree(baseSha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-'));
  const wt = path.join(dir, 'wt');
  const res = spawnSync('git', ['worktree', 'add', '--detach', '-q', wt, baseSha], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);
  const info = { dir, wt };
  activeWorktrees.add(info);
  return info;
}

function removeWorktree(info) {
  if (!info) return;
  spawnSync('git', ['worktree', 'remove', '-f', info.wt], { cwd: REPO_ROOT, encoding: 'utf8' });
  try { fs.rmSync(info.dir, { recursive: true, force: true }); } catch (e) {}
  activeWorktrees.delete(info);
}

function removeAllActiveWorktrees() {
  for (const info of [...activeWorktrees]) removeWorktree(info);
}

// Removes worktrees orphaned by a previous run that was killed before cleanup
// (e.g. the 2026-10-05 incident). Scans $TMPDIR for coder-cost-*/wt dirs.
function sweepStaleWorktrees() {
  const tmp = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch (e) { return; }
  for (const name of entries) {
    if (!name.startsWith('coder-cost-')) continue;
    const dir = path.join(tmp, name);
    const wt = path.join(dir, 'wt');
    if (!fs.existsSync(wt)) continue; // not a worktree container (e.g. an unrelated tmp dir) — leave it alone
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO_ROOT, encoding: 'utf8' });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function copyHiddenTests(wt, solutionSha, hiddenTests) {
  for (const tf of hiddenTests) {
    const show = spawnSync('git', ['show', `${solutionSha}:${tf}`], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (show.status !== 0) throw new Error(`could not read hidden test ${tf} at ${solutionSha}`);
    fs.mkdirSync(path.join(wt, path.dirname(tf)), { recursive: true });
    fs.writeFileSync(path.join(wt, tf), show.stdout);
  }
}

function runChecker(wt, hiddenTests) {
  const res = spawnSync('bun', ['test', ...hiddenTests], { cwd: wt, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  if (res.error && res.error.code === 'ETIMEDOUT') return { outcome: 'timeout', raw: res };
  return { outcome: res.status === 0 ? 'pass' : 'fail', raw: res };
}

// Writes a per-run settings JSON (not the worktree's tracked .claude/settings.json)
// wiring only the PostToolUse elapsed-time hook, passed to claude via --settings.
// PostToolUse (not UserPromptSubmit) fires after every tool call, so the elapsed
// time actually updates turn to turn in `-p` mode instead of being injected once.
function setupTimeAware(wt, cfg) {
  if (!cfg.time_aware) return null;
  const hookPath = path.join(EVAL_DIR, 'hooks', 'elapsed-time-hook.js');
  const settings = {
    hooks: {
      PostToolUse: [{ hooks: [{ type: 'command', command: `bun ${hookPath}` }] }],
    },
  };
  const settingsPath = path.join(wt, '.coder-cost-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

// Instrument (a): take the CLI's own reported usage/cost from --output-format json.
function costFromAgentJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const cost = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
  const usage = parsed.usage || null;
  return { cost, usage, session_id: parsed.session_id || null };
}

function findTranscript(sessionId, projectsRoot) {
  if (!sessionId || !fs.existsSync(projectsRoot)) return null;
  for (const dir of fs.readdirSync(projectsRoot)) {
    const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Instrument (b): recompute from the session transcript, deduped by message.id, priced
// per-message via bin/advisor-cost's priceForModel (exact model ids, verified 2026-10-05).
// usage.cache_creation on the Messages API is {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens};
// each is priced at its own rate (cache_creation = 5m write rate, cache_write_1h = 1h write rate).
function costFromTranscript(sessionId, fallbackModel, projectsRoot = path.join(os.homedir(), '.claude', 'projects')) {
  if (!sessionId) return { cost: null, note: 'no session_id reported by CLI' };
  const transcriptPath = findTranscript(sessionId, projectsRoot);
  if (!transcriptPath) return { cost: null, note: `no transcript found for session ${sessionId} under ${projectsRoot}` };
  const seen = new Set();
  let input = 0, output = 0, cacheRead = 0, cache5m = 0, cache1h = 0, cost = 0;
  const unpriced = new Set();
  for (const rec of readJsonl(transcriptPath)) {
    const msg = rec && rec.message;
    if (!msg || !msg.id || seen.has(msg.id)) continue;
    seen.add(msg.id);
    const u = msg.usage;
    if (!u) continue;
    const modelId = msg.model || fallbackModel;
    const rate = priceForModel(modelId);
    if (!rate.known) unpriced.add(modelId);
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
    const c5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
    const c1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
    input += inTok; output += outTok; cacheRead += cr; cache5m += c5; cache1h += c1;
    cost += (inTok / 1e6) * rate.input + (outTok / 1e6) * rate.output + (cr / 1e6) * rate.cache_read
      + (c5 / 1e6) * rate.cache_creation + (c1 / 1e6) * rate.cache_write_1h;
  }
  return {
    cost,
    tokens: { input, output, cacheRead, cache5m, cache1h },
    note: unpriced.size ? `unpriced models: ${[...unpriced].join(',')}` : null,
  };
}

// Pure comparison between the two cost instruments. A missing instrument is itself a flagged
// disagreement (silently treating "B unavailable" as "A and B agree" would hide the exact failure
// mode the two-instrument design exists to catch).
function disagreement(aCost, bCost) {
  const aOk = typeof aCost === 'number';
  const bOk = typeof bCost === 'number';
  if (!bOk) return { pct: null, flag: true, reason: 'instrument_b_missing' };
  if (!aOk) return { pct: null, flag: true, reason: 'instrument_a_missing' };
  if (bCost === 0) return aCost === 0 ? { pct: 0, flag: false, reason: null } : { pct: null, flag: true, reason: 'instrument_b_zero' };
  const pct = Math.abs(aCost - bCost) / bCost * 100;
  return { pct, flag: pct > 5, reason: pct > 5 ? 'cost_mismatch' : null };
}

// Promise-based spawn so multiple claude invocations can run concurrently
// (spawnSync blocks the event loop and made --concurrency a no-op).
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, opts);
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' });
      return;
    }
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = opts.timeout ? setTimeout(() => {
      timedOut = true;
      child.kill(opts.killSignal || 'SIGKILL');
    }, opts.timeout) : null;
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ error, stdout, stderr, status: null }); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) resolve({ error: { code: 'ETIMEDOUT' }, stdout, stderr, status: null });
      else resolve({ status: code, stdout, stderr });
    });
  });
}

async function runOne(configName, cfg, kase, trial) {
  const record = {
    ts: new Date().toISOString(),
    config: configName, case_id: kase.id, trial,
    base_sha: kase.base_sha, solution_sha: kase.solution_sha,
  };
  let wtInfo;
  try {
    wtInfo = makeWorktree(kase.base_sha);
  } catch (e) {
    return { ...record, outcome: 'error', error: String(e.message || e) };
  }
  const { wt } = wtInfo;
  try {
    const settingsPath = setupTimeAware(wt, cfg);
    const args = ['-p', kase.brief, '--model', cfg.model, '--effort', cfg.effort,
      '--permission-mode', 'auto', '--strict-mcp-config', '--output-format', 'json'];
    if (cfg.append_system_prompt) args.push('--append-system-prompt', cfg.append_system_prompt);
    if (settingsPath) args.push('--settings', settingsPath);

    const env = scrubEnv();
    if (cfg.time_aware) env.CODER_COST_START_MS = String(Date.now());

    const start = Date.now();
    const res = await spawnAsync('claude', args, {
      cwd: wt, env, timeout: (kase.timeout_sec || 600) * 1000, killSignal: 'SIGKILL',
    });
    const wallSec = Math.round((Date.now() - start) / 1000);

    if (res.error && res.error.code === 'ETIMEDOUT') {
      return { ...record, outcome: 'timeout', wall_clock_sec: wallSec };
    }
    if (res.error) {
      return { ...record, outcome: 'error', error: String(res.error.message || res.error), wall_clock_sec: wallSec };
    }

    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch (e) {
      return { ...record, outcome: 'error', error: 'agent stdout was not valid JSON', wall_clock_sec: wallSec, stdout_tail: (res.stdout || '').slice(-2000) };
    }

    const instrumentA = costFromAgentJson(parsed);
    const instrumentB = costFromTranscript(instrumentA && instrumentA.session_id, cfg.model);
    const diag = disagreement(instrumentA && instrumentA.cost, instrumentB && instrumentB.cost);

    let checkerResult;
    try {
      copyHiddenTests(wt, kase.solution_sha, kase.hidden_tests);
      checkerResult = runChecker(wt, kase.hidden_tests);
    } catch (e) {
      return { ...record, outcome: 'error', error: String(e.message || e), wall_clock_sec: wallSec, cost_instrument_a: instrumentA, cost_instrument_b: instrumentB };
    }

    return {
      ...record,
      outcome: checkerResult.outcome,
      wall_clock_sec: wallSec,
      cost_instrument_a: instrumentA,
      cost_instrument_b: instrumentB,
      cost_disagreement_pct: diag.pct,
      cost_disagreement_flag: diag.flag,
      cost_disagreement_reason: diag.reason,
    };
  } finally {
    removeWorktree(wtInfo);
  }
}

// Runs `jobs` with up to `concurrency` in flight at once; each result is appended
// to outFile as a single JSON line as soon as it completes (atomic, resumable).
async function runPool(jobs, concurrency, outFile) {
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const result = await runOne(job.cn, job.cfg, job.kase, job.t);
      fs.appendFileSync(outFile, JSON.stringify(result) + '\n');
      console.log(`[${job.cn}/${job.kase.id}/t${job.t}] -> ${result.outcome}`);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

let signalHandlersInstalled = false;
function installSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      removeAllActiveWorktrees();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
    return;
  }

  if (args.unknown.length) {
    console.error(`unknown argument(s): ${args.unknown.join(', ')}`);
    process.exit(2);
    return;
  }

  const allConfigs = loadConfigs();
  const allCases = loadCases();

  const configNames = args.configs || Object.keys(allConfigs);
  const caseIds = args.cases && args.cases[0] !== 'all' ? args.cases : allCases.map((c) => c.id);
  const cases = allCases.filter((c) => caseIds.includes(c.id));

  const plan = buildPlan(configNames, allConfigs, cases, args.trials);

  if (!args.confirm || args.dryRun) {
    printDryRunPlan(plan, configNames, cases, args.trials);
    process.exit(3);
    return;
  }

  installSignalHandlers();
  process.on('exit', removeAllActiveWorktrees);
  sweepStaleWorktrees();

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(RESULTS_DIR, `${runId}.jsonl`);
  const completed = loadCompletedSet();

  const jobs = [];
  for (const cn of configNames) {
    const cfg = allConfigs[cn];
    if (!cfg) { console.error(`unknown config: ${cn}`); continue; }
    for (const kase of cases) {
      for (let t = 1; t <= args.trials; t++) {
        if (completed.has(completedKey(cn, kase.id, t))) continue;
        jobs.push({ cn, cfg, kase, t });
      }
    }
  }

  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, args.concurrency || 2));
  console.log(`Running ${jobs.length} job(s) (skipped ${completed.size} already-completed tuples), concurrency=${concurrency}`);

  try {
    await runPool(jobs, concurrency, outFile);
  } finally {
    removeAllActiveWorktrees();
  }
  console.log(`Results written to ${outFile}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = {
  estimateRunCost, costFromAgentJson, costFromTranscript, findTranscript, disagreement,
  loadCompletedSet, completedKey, parseArgs, scrubEnv, runChecker, runOne, runPool,
  sweepStaleWorktrees, setupTimeAware, buildPlan, RESULTS_DIR, activeWorktrees,
};
