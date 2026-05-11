'use strict';

const { test, expect, afterAll } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ADVISOR_ROOT = path.resolve(__dirname, '..');
const SUMMON_JS    = path.join(ADVISOR_ROOT, 'lib', 'summon.js');
const CHANNEL_JS   = path.join(ADVISOR_ROOT, 'lib', 'channel.js');
const OBS_BIN      = path.join(ADVISOR_ROOT, 'bin', 'advisor-observe');

const TS       = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-adv-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-adv-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

// Provision one researcher session at module load; shared by tests A & B.
// Using lib/summon.js directly avoids spawning a claude background process.
const AB_SID = `smoke-ab-${TS}`;
const abResult = spawnSync('node', [
  SUMMON_JS,
  '--agent', 'researcher',
  '--task',  'smoke integration test — ignore',
  '--goal',  'smoke goal',
  '--sid',   AB_SID,
], {
  encoding: 'utf8',
  env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
});
if (abResult.status !== 0) {
  throw new Error(`Module-level summon failed: ${abResult.stderr}`);
}
const abMeta = JSON.parse(abResult.stdout.trim());

// ── A: Launch script contains retry loop ────────────────────────────────

test('A: launch.sh contains _attempt and classifyError (transient-retry wired)', () => {
  const launchSh = fs.readFileSync(abMeta.launchScript, 'utf8');
  expect(launchSh).toContain('_attempt');
  expect(launchSh).toContain('classifyError');
});

// ── B: Bootstrap prompt excludes scaffolding (preflight fail-open) ───────

test('B: bootstrap prompt excludes [DISCOVERY_SCAFFOLDING] when preflight fails open', () => {
  const prompt = fs.readFileSync(abMeta.promptFile, 'utf8');
  expect(prompt).not.toContain('[DISCOVERY_SCAFFOLDING]');
});

// ── C: Bootstrap prompt includes scaffolding when discoveryHint forced ───

test('C: composeBootstrapPrompt with discoveryHint:true includes [DISCOVERY_SCAFFOLDING]', () => {
  const { composeBootstrapPrompt } = require('../lib/summon.js');
  const out = composeBootstrapPrompt({
    sid: `smoke-c-${TS}`,
    agentName: 'coder',
    workspace:   os.tmpdir(),
    channelDir:  os.tmpdir(),
    outputDir:   os.tmpdir(),
    advisorRoot: ADVISOR_ROOT,
    repo:        os.tmpdir(),
    outputReason: 'test',
    goal: 'test goal',
    discoveryHint: true,
  });
  expect(out).toContain('[DISCOVERY_SCAFFOLDING]');
});

// ── D: resolveNextAgent returns evaluator from real agents/ dir ──────────

test('D: resolveNextAgent("researcher") returns "evaluator" against real agents/ dir', () => {
  const { resolveNextAgent } = require('../lib/chain.js');
  const next = resolveNextAgent('researcher');
  expect(next).toBe('evaluator');
});

// ── E: channel.js synthesize persists terminal.json ─────────────────────

test('E: channel.js synthesize persists terminal.json for a result message', () => {
  const sid      = `smoke-e-${TS}`;
  const runsDir  = path.join(HOME_TMP, '.advisor', 'runs');
  const chanDir  = path.join(runsDir, sid, 'channel');
  fs.mkdirSync(chanDir, { recursive: true });

  const resultMsg = {
    seq: 1,
    type: 'result',
    body: { summary: 'smoke-e done', verdict: 'complete', paths: [] },
    from: 'coder',
    ts: Date.now() / 1000,
  };
  fs.writeFileSync(path.join(chanDir, 'outbox.jsonl'), JSON.stringify(resultMsg) + '\n');

  const r = spawnSync('node', [
    CHANNEL_JS, 'synthesize',
    '--sid',         sid,
    '--seq',         '1',
    '--established', 'terminal persistence wired into synthesize',
    '--gap',         'none',
    '--material',    'yes',
    '--next',        'done',
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOME_TMP, ADVISOR_RUNS_ROOT: runsDir },
    timeout: 10000,
  });

  expect(r.status).toBe(0);

  const terminalPath = path.join(chanDir, 'terminal.json');
  expect(fs.existsSync(terminalPath)).toBe(true);

  const data = JSON.parse(fs.readFileSync(terminalPath, 'utf8'));
  expect(data.seq).toBe(1);
  expect(data.type).toBe('result');
});

// ── F: advisor-observe fast-exits when terminal.json present ────────────

test('F: advisor-observe exits 0 with terminal payload in under 2s', () => {
  const sid     = `smoke-f-${TS}`;
  const chanDir = path.join(HOME_TMP, '.advisor', 'runs', sid, 'channel');
  fs.mkdirSync(chanDir, { recursive: true });

  const { persistTerminal } = require('../lib/terminal-persist.js');
  const payload = { seq: 99, type: 'result', body: 'smoke-f ok', ts: Date.now() / 1000 };
  persistTerminal(chanDir, payload);
  fs.writeFileSync(path.join(chanDir, 'outbox.jsonl'), '');

  const t0 = process.hrtime.bigint();
  const r = spawnSync('node', [
    OBS_BIN, sid, '--after', '0', '--max-wait', '2',
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOME_TMP },
    timeout: 5000,
  });
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;

  expect(r.status).toBe(0);
  expect(r.stdout).toContain('"seq":99');
  expect(elapsedSec).toBeLessThan(2);
});
