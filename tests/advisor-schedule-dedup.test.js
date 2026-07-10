import { describe, test, expect, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'advisor-schedule');

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'adv-sched-test-'));
  writeFileSync(join(dir, 'summon'), '#!/usr/bin/env bash\nsleep 60\n');
  chmodSync(join(dir, 'summon'), 0o755);
  const dest = join(dir, 'advisor-schedule');
  writeFileSync(dest, readFileSync(SCRIPT));
  chmodSync(dest, 0o755);
  return dest;
}

function windowsFor(sid) {
  try {
    const out = execFileSync('tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_index}:#{window_name}']).toString();
    return out.split('\n').filter((l) => l.endsWith(`:adv-sched-${sid}`));
  } catch {
    return [];
  }
}

function killWindows(sid) {
  for (const line of windowsFor(sid)) {
    const target = line.split(':').slice(0, 2).join(':');
    try { execFileSync('tmux', ['kill-window', '-t', target]); } catch {}
  }
  try { execFileSync('tmux', ['kill-session', '-t', `adv-sched-${sid}`]); } catch {}
}

function run(script, args) {
  try {
    const out = execFileSync(script, args, { encoding: 'utf8' });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

describe('advisor-schedule per-sid dedup guard', () => {
  const sid = `dedup${Date.now()}`;

  afterEach(() => killWindows(sid));

  test('second call for same sid refuses with nonzero exit', () => {
    const script = makeHarness();
    const first = run(script, ['--sid', sid, '--interval', '60s', '--task', 't1']);
    expect(first.code).toBe(0);
    expect(windowsFor(sid).length).toBe(1);

    const second = run(script, ['--sid', sid, '--interval', '60s', '--task', 't2']);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toMatch(/already exists/);
    expect(windowsFor(sid).length).toBe(1);
  });

  test('--replace kills the existing loop and starts a fresh one', () => {
    const script = makeHarness();
    run(script, ['--sid', sid, '--interval', '60s', '--task', 't1']);
    expect(windowsFor(sid).length).toBe(1);

    const replaced = run(script, ['--sid', sid, '--interval', '60s', '--task', 't2', '--replace']);
    expect(replaced.code).toBe(0);
    expect(windowsFor(sid).length).toBe(1);
  });
});
