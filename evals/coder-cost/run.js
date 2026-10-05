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
const { buildPluginOverrides } = require('../../lib/summon.js');

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
//
// Two sources, history first:
//   (a) history: the mean of this config's own priced result rows (same-case rows
//       preferred when present), read from results/*.jsonl, results/<subdir>/*.jsonl
//       (skipping any `_invalid*` subdir) plus CODER_COST_HISTORY_FILES.
//   (b) fallback: a multi-turn token model (context grows per turn, cached via 1h
//       writes, re-read in full each subsequent turn) priced via bin/advisor-cost.
//       Constants calibrated against measured matrixA1/smoke3 means (see changes.md).

function rowCost(rec) {
  const b = rec.cost_instrument_b && typeof rec.cost_instrument_b.cost === 'number' ? rec.cost_instrument_b.cost : null;
  if (b != null) return b;
  const a = rec.cost_instrument_a && typeof rec.cost_instrument_a.cost === 'number' ? rec.cost_instrument_a.cost : null;
  return a;
}

// Timeouts count (they are priced); no_attempt and trivial (<=3-turn, e.g. a clarifying
// question with no real attempt) rows are excluded as not representative of a real run.
function isRepresentativeRow(rec) {
  if (!rec || rec.outcome === 'no_attempt') return false;
  if (typeof rec.num_turns === 'number' && rec.num_turns <= 3) return false;
  return true;
}

function listHistoryFiles(resultsDir = RESULTS_DIR) {
  const files = [];
  if (fs.existsSync(resultsDir)) {
    for (const name of fs.readdirSync(resultsDir)) {
      const full = path.join(resultsDir, name);
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) {
        if (name.startsWith('_invalid')) continue;
        for (const sub of fs.readdirSync(full)) {
          if (sub.endsWith('.jsonl')) files.push(path.join(full, sub));
        }
      } else if (name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  }
  if (process.env.CODER_COST_HISTORY_FILES) {
    for (const p of process.env.CODER_COST_HISTORY_FILES.split(',').map((s) => s.trim()).filter(Boolean)) {
      files.push(p);
    }
  }
  return files;
}

// Map of configName -> [{cost, case_id}], built from every representative priced row found.
function loadHistory(resultsDir = RESULTS_DIR) {
  const byConfig = {};
  for (const file of listHistoryFiles(resultsDir)) {
    for (const rec of readJsonl(file)) {
      if (!rec || !rec.config || !isRepresentativeRow(rec)) continue;
      const cost = rowCost(rec);
      if (cost == null) continue;
      (byConfig[rec.config] = byConfig[rec.config] || []).push({ cost, case_id: rec.case_id });
    }
  }
  return byConfig;
}

// Mean of a config's history rows, preferring rows for the same case id when present.
function historyEstimate(history, configName, caseId) {
  const rows = history[configName];
  if (!rows || rows.length === 0) return null;
  const sameCase = rows.filter((r) => r.case_id === caseId);
  const pool = sameCase.length ? sameCase : rows;
  const mean = pool.reduce((s, r) => s + r.cost, 0) / pool.length;
  return { cost: mean, n: pool.length };
}

// Fallback params: T turns of growing context, each re-read in full (cache_read) and its
// delta written once (cache_write_1h), plus per-turn output. Calibrated (see changes.md)
// against measured means: sonnet5-medium/medium ~$1.25/run, opus55-low/low ~$0.57/run.
const FALLBACK_PARAMS = {
  turns: { low: 12, medium: 38, high: 55 },
  outputPerTurn: { low: 350, medium: 450, high: 600 },
  growthPerTurn: 4200,
  baseContext: 15000,
};

function computeFallbackCost(cfg) {
  const rate = priceForModel(cfg.model);
  const effort = FALLBACK_PARAMS.turns[cfg.effort] ? cfg.effort : 'medium';
  const T = FALLBACK_PARAMS.turns[effort];
  const GROWTH = FALLBACK_PARAMS.growthPerTurn;
  const BASE = FALLBACK_PARAMS.baseContext;
  const outPerTurn = FALLBACK_PARAMS.outputPerTurn[effort];
  let cost = (BASE / 1e6) * rate.cache_write_1h;
  for (let t = 2; t <= T; t++) {
    const priorContext = BASE + GROWTH * (t - 2);
    cost += (priorContext / 1e6) * rate.cache_read + (GROWTH / 1e6) * rate.cache_write_1h;
  }
  cost += (T * outPerTurn / 1e6) * rate.output;
  return cost;
}

function estimateRunCost(kase, cfg, configName, history) {
  if (configName && history) {
    const hist = historyEstimate(history, configName, kase.id);
    if (hist) return { cost: hist.cost, source: `history n=${hist.n}` };
  }
  return { cost: computeFallbackCost(cfg), source: 'model' };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function buildPlan(configNames, allConfigs, cases, trials, history = loadHistory()) {
  const rows = [];
  let total = 0;
  let p90Total = 0;
  const configSummary = [];
  for (const cn of configNames) {
    const cfg = allConfigs[cn];
    if (!cfg) { console.error(`unknown config: ${cn}`); continue; }
    const histRows = history[cn] || [];
    const p90 = percentile(histRows.map((r) => r.cost).sort((a, b) => a - b), 90);
    let configTotal = 0, configP90Total = 0, historyRuns = 0;
    for (const kase of cases) {
      for (let t = 1; t <= trials; t++) {
        const est = estimateRunCost(kase, cfg, cn, history);
        total += est.cost;
        configTotal += est.cost;
        const upperPerRun = p90 != null ? p90 : est.cost * 1.5;
        p90Total += upperPerRun;
        configP90Total += upperPerRun;
        if (est.source !== 'model') historyRuns++;
        rows.push({ config: cn, case: kase.id, trial: t, est_cost_usd: Number(est.cost.toFixed(4)), source: est.source });
      }
    }
    const runCount = cases.length * trials;
    // Label the whole config, not whichever case happened to be estimated last.
    const source = historyRuns === 0 ? 'model'
      : `history n=${histRows.length}${historyRuns < runCount ? `, model for ${runCount - historyRuns} run(s)` : ''}`;
    configSummary.push({ config: cn, perRunEst: runCount ? configTotal / runCount : 0, source, total: configTotal, p90Total: configP90Total });
  }
  return { rows, total, p90Total, configSummary };
}

function printDryRunPlan(plan, configNames, cases, trials) {
  console.log(`DRY RUN plan: ${plan.rows.length} runs across ${configNames.length} configs x ${cases.length} cases x ${trials} trial(s)`);
  for (const s of plan.configSummary) {
    console.log(`  ${s.config}: est $${s.perRunEst.toFixed(4)}/run (${s.source}), config total $${s.total.toFixed(2)}`);
  }
  console.log(`Estimated total notional spend: $${plan.total.toFixed(2)} (rough order-of-magnitude, priced via bin/advisor-cost rates)`);
  console.log(`Estimated p90 upper-bound total: $${plan.p90Total.toFixed(2)}`);
  console.log(JSON.stringify(plan.rows, null, 2));
}

function scrubEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'SSE_PORT', 'CHILD_SESSION', 'ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_I_SENTINEL']) {
    delete env[k];
  }
  return env;
}

// Exact text required by the isolation spec (2026-10-05 incident): the eval
// model must behave like a plain coding agent, never the Advisor orchestrator.
const NEUTRAL_CLAUDE_MD = 'You are a software engineer working directly in this repository. Implement the task yourself with your own tools. Do not run bin/summon, bin/advisor-* or any agent-orchestration script, do not spawn other agents, and do not run git commands that create, move or delete branches, worktrees or refs, or that push. When you believe the task is complete, stop.';

// Strips the repo's own Advisor doctrine from the clone (claude.md/CLAUDE.md
// collide on this case-insensitive filesystem) and the whole .claude/ dir,
// then writes a neutral CLAUDE.md so the eval model can't act as the Advisor.
function setupNeutralWorkspace(wt) {
  for (const name of ['claude.md', 'CLAUDE.md']) {
    try { fs.rmSync(path.join(wt, name), { force: true }); } catch (e) {}
  }
  try { fs.rmSync(path.join(wt, '.claude'), { recursive: true, force: true }); } catch (e) {}
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), NEUTRAL_CLAUDE_MD + '\n');
  // Commit the swap so the model starts from a clean tree: an uncommitted deletion
  // read as "pre-existing breakage" and invited git stash games that lost files.
  const g = (...a) => spawnSync('git', a, { cwd: wt, encoding: 'utf8' });
  g('add', '-A');
  g('-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-q', '--no-verify', '-m', 'eval: neutral workspace');
}

// Overridable so tests can point this at a fixture instead of the real
// ~/.claude/settings.json (whose enabledPlugins vary machine to machine).
const USER_SETTINGS_FILE = process.env.CODER_COST_USER_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');

// Builds the single --settings JSON for a run: disables every plugin enabled
// in the user's own settings (reusing lib/summon.js's worker-isolation helper
// so eval models can't load the operator's plugins) and, for time_aware
// configs only, adds the PostToolUse elapsed-time hook on top.
function buildRunSettings(wt, cfg) {
  let userSettings = null;
  try { userSettings = JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8')); } catch (e) {}
  const settings = {};
  const pluginOverrides = buildPluginOverrides(userSettings, []);
  if (Object.keys(pluginOverrides).length > 0) settings.enabledPlugins = pluginOverrides;
  if (cfg.time_aware) {
    const hookPath = path.join(EVAL_DIR, 'hooks', 'elapsed-time-hook.js');
    settings.hooks = { PostToolUse: [{ hooks: [{ type: 'command', command: `bun ${hookPath}` }] }] };
  }
  const settingsPath = path.join(wt, '.coder-cost-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

// Tools no eval model may use: orchestration scripts and ref/worktree-mutating
// git commands (2026-10-05 incident) plus ScheduleWakeup (Advisor-only).
const EVAL_DISALLOWED_TOOLS = [
  'Bash(bin/summon:*)', 'Bash(bin/advisor-*:*)', 'Bash(git push:*)',
  'Bash(git worktree:*)', 'Bash(git branch:*)', 'Bash(git checkout:*)',
  'ScheduleWakeup',
];

// Tracks clones currently checked out so a terminating signal can remove them all.
const activeWorktrees = new Set();

// A `git clone --shared --no-checkout` instead of `git worktree add`: the clone
// gets its own refs (a `git branch`/`git checkout` inside it can never touch the
// source repo's refs) while --shared avoids copying objects. --no-checkout +
// a separate `checkout --detach` pins it to the case's base_sha.
function makeWorktree(baseSha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cost-'));
  const wt = path.join(dir, 'repo');
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() }));
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', '-q', REPO_ROOT, wt], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
  const checkout = spawnSync('git', ['checkout', '--detach', '-q', baseSha], { cwd: wt, encoding: 'utf8' });
  if (checkout.status !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`);
  const info = { dir, wt };
  activeWorktrees.add(info);
  return info;
}

function removeWorktree(info) {
  if (!info) return;
  try { fs.rmSync(info.dir, { recursive: true, force: true }); } catch (e) {}
  activeWorktrees.delete(info);
}

function removeAllActiveWorktrees() {
  for (const info of [...activeWorktrees]) removeWorktree(info);
}

// Removes stale run artifacts left by a previous run killed before cleanup
// (e.g. the 2026-10-05 incident): both post-migration clone dirs (plain rm -rf)
// and pre-migration `git worktree add` dirs (still need `git worktree remove`
// or the source repo's .git/worktrees metadata leaks). Scans $TMPDIR for
// coder-cost-* containers.
const LEGACY_DIR_MAX_AGE_MS = 6 * 3600 * 1000;

// A dir is stale only if its owner pid is dead; dirs without an owner.json
// (pre-ownership runs) are stale only once older than LEGACY_DIR_MAX_AGE_MS.
function isStaleRunDir(dir) {
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch (e) {}
  if (owner && Number.isInteger(owner.pid)) {
    try { process.kill(owner.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
  }
  try { return Date.now() - fs.statSync(dir).mtimeMs > LEGACY_DIR_MAX_AGE_MS; } catch (e) { return false; }
}

function sweepStaleWorktrees() {
  const tmp = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch (e) { return; }
  let prunedLegacy = false;
  for (const name of entries) {
    if (!name.startsWith('coder-cost-')) continue;
    const dir = path.join(tmp, name);
    if (!isStaleRunDir(dir)) continue;
    const legacyWt = path.join(dir, 'wt');
    const cloneDir = path.join(dir, 'repo');
    if (fs.existsSync(legacyWt)) {
      spawnSync('git', ['worktree', 'remove', '--force', legacyWt], { cwd: REPO_ROOT, encoding: 'utf8' });
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      prunedLegacy = true;
    } else if (fs.existsSync(cloneDir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  }
  if (prunedLegacy) spawnSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function copyHiddenTests(wt, solutionSha, hiddenTests, baseSha) {
  // Doctrine was stripped only to keep the model from acting as the Advisor; some hidden
  // tests read claude.md or .claude/hooks, so restore the base versions before checking.
  for (const p of ['claude.md', '.claude']) {
    spawnSync('git', ['checkout', baseSha || 'HEAD', '--', p], { cwd: wt, encoding: 'utf8' });
  }
  for (const tf of hiddenTests) {
    const show = spawnSync('git', ['show', `${solutionSha}:${tf}`], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (show.status !== 0) throw new Error(`could not read hidden test ${tf} at ${solutionSha}`);
    fs.mkdirSync(path.join(wt, path.dirname(tf)), { recursive: true });
    fs.writeFileSync(path.join(wt, tf), show.stdout);
  }
}

// Files/paths the harness itself writes into the worktree that must never count
// as a "model made changes" signal.
const IGNORED_CHANGE_PATHS = new Set(['.coder-cost-settings.json']);

// True if anything changed in the worktree since `sinceSha` (the commit right
// after setupNeutralWorkspace's own swap-commit), covering both committed diffs
// and uncommitted/untracked files, minus the harness's own housekeeping files.
function worktreeChanged(wt, sinceSha) {
  const diff = spawnSync('git', ['diff', '--name-only', sinceSha], { cwd: wt, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: wt, encoding: 'utf8' });
  const files = new Set();
  for (const l of (diff.stdout || '').split('\n')) { const f = l.trim(); if (f) files.add(f); }
  for (const l of (status.stdout || '').split('\n')) { const f = l.slice(3).trim(); if (f) files.add(f); }
  for (const ignored of IGNORED_CHANGE_PATHS) files.delete(ignored);
  return files.size > 0;
}

function runChecker(wt, hiddenTests) {
  const res = spawnSync('bun', ['test', ...hiddenTests], { cwd: wt, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  if (res.error && res.error.code === 'ETIMEDOUT') return { outcome: 'timeout', raw: res };
  return { outcome: res.status === 0 ? 'pass' : 'fail', raw: res };
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

    // The advisor-tool call runs on its own model (e.g. opus) separate from the
    // main assistant model; it rides along inside usage.iterations and was
    // previously dropped entirely (2026-10-05 incident). Dedup is inherited
    // from the outer `seen` set on msg.id — these only run once per message.
    if (Array.isArray(u.iterations)) {
      for (const iter of u.iterations) {
        if (!iter || iter.type !== 'advisor_message') continue;
        const iterModel = iter.model || modelId;
        const iterRate = priceForModel(iterModel);
        if (!iterRate.known) unpriced.add(iterModel);
        const iIn = iter.input_tokens || 0;
        const iOut = iter.output_tokens || 0;
        const iCr = iter.cache_read_input_tokens || 0;
        const iCc = iter.cache_creation && typeof iter.cache_creation === 'object' ? iter.cache_creation : null;
        const iC5 = iCc ? (iCc.ephemeral_5m_input_tokens || 0) : 0;
        const iC1 = iCc ? (iCc.ephemeral_1h_input_tokens || 0) : 0;
        cost += (iIn / 1e6) * iterRate.input + (iOut / 1e6) * iterRate.output + (iCr / 1e6) * iterRate.cache_read
          + (iC5 / 1e6) * iterRate.cache_creation + (iC1 / 1e6) * iterRate.cache_write_1h;
      }
    }
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
    setupNeutralWorkspace(wt);
    const neutralShaRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' });
    const neutralSha = neutralShaRes.stdout.trim();
    const settingsPath = buildRunSettings(wt, cfg);
    const args = ['-p', kase.brief, '--model', cfg.model, '--effort', cfg.effort,
      '--permission-mode', 'auto', '--strict-mcp-config', '--output-format', 'json',
      '--setting-sources', 'user', '--settings', settingsPath,
      '--disallowedTools', EVAL_DISALLOWED_TOOLS.join(',')];
    if (cfg.append_system_prompt) args.push('--append-system-prompt', cfg.append_system_prompt);
    // Pinned so a killed (timed-out) run's transcript can still be priced: those are
    // the most expensive runs and the CLI emits no JSON for them.
    const pinnedSessionId = require('crypto').randomUUID();
    args.push('--session-id', pinnedSessionId);

    const env = scrubEnv();
    env.ADVISOR_STATE_DIR = path.join(wtInfo.dir, 'state');
    env.ADVISOR_WORKER_HOOKS = '1';
    if (cfg.time_aware) env.CODER_COST_START_MS = String(Date.now());

    const start = Date.now();
    const res = await spawnAsync('claude', args, {
      cwd: wt, env, timeout: (kase.timeout_sec || 600) * 1000, killSignal: 'SIGKILL',
    });
    const wallSec = Math.round((Date.now() - start) / 1000);
    const claudeExitCode = res.status != null ? res.status : null;

    if (res.error && res.error.code === 'ETIMEDOUT') {
      return { ...record, outcome: 'timeout', wall_clock_sec: wallSec, claude_exit_code: claudeExitCode,
        session_id: pinnedSessionId, cost_instrument_a: null, cost_instrument_b: costFromTranscript(pinnedSessionId, cfg.model) };
    }
    if (res.error) {
      return { ...record, outcome: 'error', error: String(res.error.message || res.error), wall_clock_sec: wallSec, claude_exit_code: claudeExitCode,
        session_id: pinnedSessionId, cost_instrument_a: null, cost_instrument_b: costFromTranscript(pinnedSessionId, cfg.model) };
    }

    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch (e) {
      return { ...record, outcome: 'error', error: 'agent stdout was not valid JSON', wall_clock_sec: wallSec, claude_exit_code: claudeExitCode, stdout_tail: (res.stdout || '').slice(-2000) };
    }

    const instrumentA = costFromAgentJson(parsed);
    const instrumentB = costFromTranscript(instrumentA && instrumentA.session_id, cfg.model);
    const diag = disagreement(instrumentA && instrumentA.cost, instrumentB && instrumentB.cost);
    const sessionId = (instrumentA && instrumentA.session_id) || null;
    const numTurns = typeof parsed.num_turns === 'number' ? parsed.num_turns : null;

    // Distinguish "the model made no edits at all" from a genuine failed attempt:
    // a no_attempt run is still priced (both instruments) and still records
    // num_turns, but is never run through the hidden-test checker.
    const gitDir = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: wt, encoding: 'utf8' });
    if (!fs.existsSync(path.join(wt, '.git')) || gitDir.status !== 0) {
      return {
        ...record, outcome: 'error', error_reason: 'worktree vanished', wall_clock_sec: wallSec, claude_exit_code: claudeExitCode,
        session_id: sessionId, num_turns: numTurns, cost_instrument_a: instrumentA, cost_instrument_b: instrumentB,
        cost_disagreement_pct: diag.pct, cost_disagreement_flag: diag.flag, cost_disagreement_reason: diag.reason,
      };
    }
    if (!worktreeChanged(wt, neutralSha)) {
      return {
        ...record, outcome: 'no_attempt', wall_clock_sec: wallSec, claude_exit_code: claudeExitCode,
        session_id: sessionId, num_turns: numTurns, cost_instrument_a: instrumentA, cost_instrument_b: instrumentB,
        cost_disagreement_pct: diag.pct, cost_disagreement_flag: diag.flag, cost_disagreement_reason: diag.reason,
      };
    }

    let checkerResult;
    try {
      copyHiddenTests(wt, kase.solution_sha, kase.hidden_tests, kase.base_sha);
      checkerResult = runChecker(wt, kase.hidden_tests);
    } catch (e) {
      return { ...record, outcome: 'error', error: String(e.message || e), wall_clock_sec: wallSec, claude_exit_code: claudeExitCode, session_id: sessionId, num_turns: numTurns, cost_instrument_a: instrumentA, cost_instrument_b: instrumentB };
    }
    const checkerOutput = (checkerResult.raw.stdout || '') + (checkerResult.raw.stderr || '');

    return {
      ...record,
      outcome: checkerResult.outcome,
      wall_clock_sec: wallSec,
      claude_exit_code: claudeExitCode,
      session_id: sessionId,
      num_turns: numTurns,
      checker_exit_code: checkerResult.raw.status != null ? checkerResult.raw.status : null,
      checker_output_tail: checkerOutput.slice(-3000),
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
  sweepStaleWorktrees, buildRunSettings, setupNeutralWorkspace, buildPlan, RESULTS_DIR, activeWorktrees,
  EVAL_DISALLOWED_TOOLS, NEUTRAL_CLAUDE_MD, worktreeChanged, IGNORED_CHANGE_PATHS,
  loadHistory, historyEstimate, computeFallbackCost, rowCost, isRepresentativeRow, percentile, listHistoryFiles,
};
