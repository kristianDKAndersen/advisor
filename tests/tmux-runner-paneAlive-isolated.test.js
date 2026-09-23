import { test, expect, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { paneAlive, pollSentinel } from '../lib/tmux-runner.js';

// Real, isolated tmux server (-L socket unique to this process) so these
// tests never touch the shared/default tmux server other sessions use.
let tmuxAvailable = true;
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch (_) { tmuxAvailable = false; }

const socket = `advtest-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const exec = (cmd, args) =>
  execFileSync(cmd, ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

if (tmuxAvailable) {
  // Keeper session keeps the isolated server alive while tests run.
  exec('tmux', ['new-session', '-d', '-s', 'keeper']);
}

afterAll(() => {
  if (!tmuxAvailable) return;
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch (_) {}
});

const t = tmuxAvailable ? test : test.skip;

t('paneAlive: true for a live pane, false after kill-pane (real isolated tmux server)', () => {
  const paneId = exec('tmux', ['new-window', '-d', '-t', 'keeper', '-P', '-F', '#{pane_id}']).trim();

  expect(paneAlive(exec, paneId)).toBe(true);

  exec('tmux', ['kill-pane', '-t', paneId]);

  expect(paneAlive(exec, paneId)).toBe(false);
});

t('pollSentinel: real checkAlive probe detects a killed pane within a few seconds (real isolated tmux server)', async () => {
  const paneId = exec('tmux', ['new-window', '-d', '-t', 'keeper', '-P', '-F', '#{pane_id}']).trim();
  exec('tmux', ['kill-pane', '-t', paneId]);

  const sentinel = `/tmp/advtest-no-such-sentinel-${crypto.randomBytes(4).toString('hex')}.done`;
  const checkAlive = () => { if (!paneAlive(exec, paneId)) throw new Error(`pane ${paneId} not found`); };

  const start = Date.now();
  const done = await pollSentinel(sentinel, 10_000, 100, null, checkAlive, 200);
  const elapsed = Date.now() - start;

  expect(done).toBe(false);
  expect(elapsed).toBeLessThan(3000);
});
