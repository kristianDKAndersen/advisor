// Pins bin/summon herdr dispatch: ADVISOR_HERDR=1 + HERDR_ENV=1 routes META to the runner
// (ADVISOR_HERDR_RUNNER stub) with no tmux/osascript; any other flag combination keeps the tmux path.
import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SUMMON = path.join(ROOT, 'bin/summon');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-herdr-summon-'));
const RUNS = path.join(TMP, 'runs');
const HOME_TMP = path.join(TMP, 'home');
const BIN = path.join(TMP, 'bin');
const CALLS = path.join(TMP, 'calls.log');
const RUNNER_LOG = path.join(TMP, 'runner.log');
fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(HOME_TMP, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// tmux/osascript/curl/open stubs record their name; tmux answers so the legacy path does not abort.
for (const name of ['tmux', 'osascript', 'curl', 'open']) {
  fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${CALLS}"\nexit 0\n`, { mode: 0o755 });
}
// Fake node runner: records argv + stdin, optional failure via STUB_RUNNER_EXIT.
const STUB_RUNNER = path.join(TMP, 'stub-runner.js');
fs.writeFileSync(STUB_RUNNER, `const fs=require('fs');
fs.appendFileSync(${JSON.stringify(RUNNER_LOG)}, JSON.stringify({argv:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')})+'\\n');
if (process.env.STUB_RUNNER_EXIT) { process.stderr.write('stub runner boom\\n'); process.exit(Number(process.env.STUB_RUNNER_EXIT)); }
`);
// Stub tmux-runner target: legacy path runs lib/tmux-runner.js for real under nohup; keep it from doing work.
function run(extraArgs, envOver = {}) {
  fs.rmSync(CALLS, { force: true });
  fs.rmSync(RUNNER_LOG, { force: true });
  const sid = `test-herdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ADVISOR_RUNS_ROOT: RUNS, HOME: HOME_TMP,
    ADVISOR_HERDR_RUNNER: STUB_RUNNER, ADVISOR_TMUX_MULTIPLEX: '', ADVISOR_DEFAULT_TUI: '' };
  for (const k of ['ADVISOR_HERDR', 'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'STUB_RUNNER_EXIT', 'ADVISOR_NO_TIMELINE']) delete env[k];
  Object.assign(env, envOver);
  const r = spawnSync('bash', [SUMMON, '--agent', 'researcher', '--task', 'herdr dispatch test - ignore', '--goal', 'test', '--sid', sid, ...extraArgs], { encoding: 'utf8', env, timeout: 60000 });
  const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : [];
  const runner = fs.existsSync(RUNNER_LOG) ? fs.readFileSync(RUNNER_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, calls, runner, sid };
}
const HERDR = { ADVISOR_HERDR: '1', HERDR_ENV: '1' };
const metaOf = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{')));

test('H1: both flags -> runner gets --launch-from-meta, agent, timeout-ms, META on stdin; stdout ends with META; no tmux/osascript', () => {
  const { r, calls, runner } = run(['--no-timeline', '--timeout-sec', '120'], HERDR);
  expect(r.status).toBe(0);
  expect(runner.length).toBe(1);
  expect(runner[0].argv).toEqual(['--launch-from-meta', '--agent', 'researcher', '--timeout-ms', '120000']);
  const meta = JSON.parse(runner[0].stdin);
  expect(meta.sid).toBeTruthy();
  expect(typeof meta.launchScript).toBe('string');
  expect(typeof meta.promptFile).toBe('string');
  expect(metaOf(r.stdout)).toEqual(meta);
  expect(calls.filter((c) => /^(tmux|osascript)\b/.test(c))).toEqual([]);
});

test('H2: both flags + --tui adds --tui, never osascript or tmux', () => {
  const { r, calls, runner } = run(['--no-timeline', '--tui'], HERDR);
  expect(r.status).toBe(0);
  expect(runner[0].argv).toContain('--tui');
  expect(runner[0].argv.slice(0, 1)).toEqual(['--launch-from-meta']);
  expect(calls.filter((c) => /^(tmux|osascript)\b/.test(c))).toEqual([]);
});

test('H3: ensemble META reaches the runner with every session', () => {
  const { r, calls, runner } = run(['--no-timeline', '--ensemble', '2'], HERDR);
  expect(r.status).toBe(0);
  const meta = JSON.parse(runner[0].stdin);
  expect(meta.batch).toBe(true);
  expect(meta.sessions.length).toBe(2);
  expect(meta.sessions.every((s) => s.sid && s.launchScript && s.promptFile)).toBe(true);
  expect(calls.filter((c) => /^(tmux|osascript)\b/.test(c))).toEqual([]);
});

test('H4: runner exit 1 -> summon exits non-zero with a message on stderr and no META on stdout', () => {
  const { r } = run(['--no-timeline'], { ...HERDR, STUB_RUNNER_EXIT: '1' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('herdr');
  expect(r.stdout).not.toContain('"launchScript"');
});

test('H5: without --no-timeline the herdr path still runs the timeline autostart probe', () => {
  const { r, calls, runner } = run([], { ...HERDR, ADVISOR_TIMELINE_PORT: '1' });
  expect(r.status).toBe(0);
  expect(runner.length).toBe(1);
  expect(calls.some((c) => c.startsWith('curl '))).toBe(true);
});

for (const [label, envOver] of [['ADVISOR_HERDR=1 alone', { ADVISOR_HERDR: '1' }], ['HERDR_ENV=1 alone', { HERDR_ENV: '1' }], ['neither flag', {}]]) {
  test(`H6: ${label} -> legacy tmux path, herdr runner not called`, () => {
    const { r, calls, runner } = run(['--no-timeline', '--tui'], { ...envOver, ADVISOR_TMUX_MULTIPLEX: '1' });
    expect(r.status).toBe(0);
    expect(runner).toEqual([]);
    expect(calls.some((c) => c.startsWith('tmux '))).toBe(true);
  });
}

test('H7: ADVISOR_NO_REAPER=1 is still exported before provisioning', () => {
  const src = fs.readFileSync(SUMMON, 'utf8');
  expect(src).toMatch(/^export ADVISOR_NO_REAPER=1$/m);
  expect(src.indexOf('export ADVISOR_NO_REAPER=1')).toBeLessThan(src.indexOf('META=$(node'));
});
