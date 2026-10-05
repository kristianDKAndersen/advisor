#!/usr/bin/env bun
'use strict';
/*
 * Frozen, re-runnable eval runner for coder-worker cost/pass-rate comparison.
 * See README.md for full usage. Resumable: re-running skips any
 * (config, case, trial) tuple already present in evals/coder-cost/results/*.jsonl.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVAL_DIR = __dirname;
// Overridable so the test suite can point these at disposable fixtures instead of this repo.
const REPO_ROOT = process.env.CODER_COST_REPO_ROOT || path.resolve(EVAL_DIR, '..', '..');
const RESULTS_DIR = process.env.CODER_COST_RESULTS_DIR || path.join(EVAL_DIR, 'results');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function loadCases() {
  return readJsonl(path.join(EVAL_DIR, 'cases.jsonl'));
}

function loadConfigs() {
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'configs.json'), 'utf8'));
}

function loadRates() {
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'rates.json'), 'utf8'));
}

function parseArgs(argv) {
  const args = { trials: 1, concurrency: 2, dryRun: false, configs: null, cases: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--configs') args.configs = argv[++i].split(',');
    else if (a === '--cases') args.cases = argv[++i].split(',');
    else if (a === '--trials') args.trials = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
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
function estimateRunCost(kase, cfg, rates) {
  const BASE_CONTEXT_TOKENS = 15000; // repo/tooling overhead, heuristic
  const inputTokens = BASE_CONTEXT_TOKENS + Math.ceil((kase.brief || '').length / 4);
  const outputTokens = Math.min(20000, Math.max(1500, Math.round((kase.timeout_sec || 600) * 6)));
  const rate = rates.models[cfg.model];
  if (!rate) return null;
  const cost = (inputTokens / 1e6) * rate.input_per_mtok + (outputTokens / 1e6) * rate.output_per_mtok;
  return { inputTokens, outputTokens, cost };
}

function scrubEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'SSE_PORT', 'CHILD_SESSION', 'ENTRYPOINT', 'CLAUDECODE']) {
    delete env[k];
  }
  return env;
}

function makeWorktree(baseSha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-'));
  const wt = path.join(dir, 'wt');
  const res = spawnSync('git', ['worktree', 'add', '--detach', '-q', wt, baseSha], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);
  return { dir, wt };
}

function removeWorktree(wt, dir) {
  spawnSync('git', ['worktree', 'remove', '-f', wt], { cwd: REPO_ROOT, encoding: 'utf8' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
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

function setupTimeAware(wt, cfg) {
  if (!cfg.time_aware) return;
  fs.writeFileSync(path.join(wt, '.eval-start-ts'), String(Date.now()));
  const claudeDir = path.join(wt, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const hookPath = path.join(EVAL_DIR, 'hooks', 'elapsed-time-hook.js');
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `bun ${hookPath}` }] }],
    },
  };
  // settings.local.json (not settings.json): the worktree is checked out from this repo and may
  // already carry a tracked .claude/settings.json; writing *.local keeps the only difference from
  // sonnet5-medium being the hook + --append-system-prompt, not an overwritten tracked file.
  fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify(settings, null, 2));
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

// Instrument (b): recompute from the session transcript, deduped by message.id, at list rates.
// Transcripts are found by scanning <projectsRoot>/*/<session_id>.jsonl rather than reconstructing
// a project-dir slug from a cwd: session ids are UUIDs, so this is a unique match and sidesteps
// path-canonicalization mismatches (e.g. macOS tmpdir() vs the resolved /private/... path a
// spawned process actually sees).
function costFromTranscript(sessionId, rates, model, projectsRoot = path.join(os.homedir(), '.claude', 'projects')) {
  if (!sessionId) return { cost: null, note: 'no session_id reported by CLI' };
  const transcriptPath = findTranscript(sessionId, projectsRoot);
  if (!transcriptPath) return { cost: null, note: `no transcript found for session ${sessionId} under ${projectsRoot}` };
  const seen = new Set();
  let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
  for (const rec of readJsonl(transcriptPath)) {
    const msg = rec && rec.message;
    if (!msg || !msg.id || seen.has(msg.id)) continue;
    seen.add(msg.id);
    const u = msg.usage;
    if (!u) continue;
    input += u.input_tokens || 0;
    output += u.output_tokens || 0;
    cacheWrite += u.cache_creation_input_tokens || 0;
    cacheRead += u.cache_read_input_tokens || 0;
  }
  const rate = rates.models[model];
  if (!rate) return { cost: null, note: `no rate entry for model ${model}` };
  const cost = (input / 1e6) * rate.input_per_mtok + (output / 1e6) * rate.output_per_mtok
    + (cacheWrite / 1e6) * rate.cache_write_per_mtok + (cacheRead / 1e6) * rate.cache_read_per_mtok;
  return { cost, tokens: { input, output, cacheWrite, cacheRead }, note: rates.verified ? null : 'rates.json is unverified placeholder pricing' };
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

function runOne(configName, cfg, kase, trial, rates) {
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
  const { wt, dir } = wtInfo;
  try {
    setupTimeAware(wt, cfg);
    const args = ['-p', kase.brief, '--model', cfg.model, '--effort', cfg.effort,
      '--permission-mode', 'auto', '--strict-mcp-config', '--output-format', 'json'];
    if (cfg.append_system_prompt) args.push('--append-system-prompt', cfg.append_system_prompt);

    const start = Date.now();
    const res = spawnSync('claude', args, {
      cwd: wt, env: scrubEnv(), encoding: 'utf8',
      timeout: (kase.timeout_sec || 600) * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
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
    const instrumentB = costFromTranscript(instrumentA && instrumentA.session_id, rates, cfg.model);
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
    removeWorktree(wt, dir);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const allConfigs = loadConfigs();
  const allCases = loadCases();
  const rates = loadRates();

  const configNames = args.configs || Object.keys(allConfigs);
  const caseIds = args.cases && args.cases[0] !== 'all' ? args.cases : allCases.map((c) => c.id);
  const cases = allCases.filter((c) => caseIds.includes(c.id));

  if (args.dryRun) {
    let total = 0;
    const rows = [];
    for (const cn of configNames) {
      const cfg = allConfigs[cn];
      if (!cfg) { console.error(`unknown config: ${cn}`); continue; }
      for (const kase of cases) {
        for (let t = 1; t <= args.trials; t++) {
          const est = estimateRunCost(kase, cfg, rates);
          const cost = est ? est.cost : 0;
          total += cost;
          rows.push({ config: cn, case: kase.id, trial: t, est_cost_usd: Number(cost.toFixed(4)) });
        }
      }
    }
    console.log(`DRY RUN plan: ${rows.length} runs across ${configNames.length} configs x ${cases.length} cases x ${args.trials} trial(s)`);
    console.log(`Estimated total notional spend: $${total.toFixed(2)} (rough order-of-magnitude; rates.verified=${rates.verified})`);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

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

  console.log(`Running ${jobs.length} job(s) (skipped ${completed.size} already-completed tuples), concurrency=${args.concurrency}`);
  // eco: --concurrency is parsed but execution below is strictly sequential (spawnSync is
  // blocking, and every job's worktree uses the fixed basename "wt" under its own mkdtemp dir,
  // so this is safe as-is). Upgrade to real parallelism when concurrency>1 is actually needed:
  // switch to spawn()+Promise and give each job its own worktree dir, which it already has.
  for (const job of jobs) {
    const result = runOne(job.cn, job.cfg, job.kase, job.t, rates);
    fs.appendFileSync(outFile, JSON.stringify(result) + '\n');
    console.log(`[${job.cn}/${job.kase.id}/t${job.t}] -> ${result.outcome}`);
  }
  console.log(`Results written to ${outFile}`);
}

if (require.main === module) main();

module.exports = {
  estimateRunCost, costFromAgentJson, costFromTranscript, findTranscript, disagreement,
  loadCompletedSet, completedKey, parseArgs, scrubEnv, runChecker, runOne, RESULTS_DIR,
};
