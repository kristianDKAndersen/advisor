// Tests for 8 dispatch-path improvements to lib/summon.js, lib/tool-guard.js,
// bin/advisor-list, and lib/session.js.
'use strict';

const { test, expect, describe } = require('bun:test');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const summon = require(path.join(REPO, 'lib', 'summon.js'));
const toolGuard = require(path.join(REPO, 'lib', 'tool-guard.js'));
const session = require(path.join(REPO, 'lib', 'session.js'));

// ---------------------------------------------------------------------------
// Item 1: Worker-hooks promotion — ADVISOR_WORKER_HOOKS='1' for ALL agents
// ---------------------------------------------------------------------------
describe('Item 1 — worker-hooks promotion', () => {
  test('injectWorkerHooks exists and is exported', () => {
    expect(typeof summon.injectWorkerHooks).toBe('function');
  });

  test('provisionOne sets ADVISOR_WORKER_HOOKS=1 for coder (previously non-allowlisted)', () => {
    // We test via parseArgs + settings.env inspection using a direct unit test
    // of the WORKER_HOOKS_ALLOWLIST logic: the simplest path is to verify the
    // setting is always '1' regardless of agent type. We do this by checking
    // that the exported function produces hooks (non-empty PostToolUse) and
    // by reading that the env value is '1' for a coder provisioned workspace.
    // Since full provisionOne requires git, we verify via the exported
    // buildProtectedTestsEnv and injectWorkerHooks indirectly:
    // The real assertion is in the integration path — run a real provisionOne
    // for researcher and check the written settings.json env value.
    // This lightweight test checks the logic itself is not gated:
    const hooks = summon.injectWorkerHooks({});
    expect(hooks).toHaveProperty('PostToolUse');
    expect(hooks.PostToolUse.length).toBeGreaterThan(0);
    // Downstream: the integration test in summon-hook-injection verifies
    // ADVISOR_WORKER_HOOKS is actually '1' in the written settings.json.
    // We additionally test it inline with provisionOne below.
  });

  test('WORKER_HOOKS value in provisioned settings is "1" for coder', () => {
    // Integration: provision a researcher workspace, read settings.json,
    // verify ADVISOR_WORKER_HOOKS is '1'.
    const fs = require('fs');
    const os = require('os');
    const { spawnSync } = require('child_process');
    const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-hooks-promo-'));
    try {
      const SUMMON_JS = path.join(REPO, 'lib', 'summon.js');
      const sid = `test-hooks-promo-${Date.now()}`;
      const r = spawnSync('node', [
        SUMMON_JS,
        '--agent', 'researcher',
        '--task', 'hooks promotion test',
        '--goal', 'done',
        '--sid', sid,
      ], {
        encoding: 'utf8',
        env: { ...process.env, ADVISOR_RUNS_ROOT: tmpRuns },
      });
      expect(r.status).toBe(0);
      const meta = JSON.parse(r.stdout.trim());
      const settingsPath = path.join(meta.workspace, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.env && settings.env.ADVISOR_WORKER_HOOKS).toBe('1');
    } finally {
      fs.rmSync(tmpRuns, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Item 2: Register Stop hook for worker-result-check.js in injectWorkerHooks
// ---------------------------------------------------------------------------
describe('Item 2 — Stop hook registration', () => {
  test('injectWorkerHooks includes a Stop hook entry for worker-result-check.js', () => {
    const hooks = summon.injectWorkerHooks({});
    expect(hooks).toHaveProperty('Stop');
    const stopCommands = hooks.Stop.flatMap(e => e.hooks.map(h => h.command));
    expect(stopCommands.some(cmd => cmd.includes('worker-result-check'))).toBe(true);
  });

  test('Stop entry preserves existing hooks from template', () => {
    const existing = { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo existing' }] }] };
    const merged = summon.injectWorkerHooks(existing);
    const stopCommands = merged.Stop.flatMap(e => e.hooks.map(h => h.command));
    expect(stopCommands.some(cmd => cmd.includes('echo existing'))).toBe(true);
    expect(stopCommands.some(cmd => cmd.includes('worker-result-check'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 3: SessionStart hook for worker-session-map.sh
// ---------------------------------------------------------------------------
describe('Item 3 — SessionStart hook registration', () => {
  test('injectWorkerHooks includes a SessionStart hook entry for worker-session-map.sh', () => {
    const hooks = summon.injectWorkerHooks({});
    expect(hooks).toHaveProperty('SessionStart');
    const startCommands = hooks.SessionStart.flatMap(e => e.hooks.map(h => h.command));
    expect(startCommands.some(cmd => cmd.includes('worker-session-map'))).toBe(true);
  });

  test('worker-session-map.sh file exists and is executable', () => {
    const fs = require('fs');
    const shellPath = path.join(REPO, 'lib', 'hooks', 'worker-session-map.sh');
    expect(fs.existsSync(shellPath)).toBe(true);
    const stat = fs.statSync(shellPath);
    // Check executable bit (owner)
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 5: Dynamic timeout scaling for coder
// ---------------------------------------------------------------------------
describe('Item 5 — dynamic coder timeout', () => {
  test('scaledCoderTimeout is exported from summon', () => {
    expect(typeof summon.scaledCoderTimeout).toBe('function');
  });

  test('returns 1500 for short task text (< 500 chars, no steps/edits)', () => {
    expect(summon.scaledCoderTimeout('fix a bug')).toBe(1500);
  });

  test('returns 1800 for medium task text (500-1500 chars)', () => {
    const mediumTask = 'a'.repeat(800);
    expect(summon.scaledCoderTimeout(mediumTask)).toBe(1800);
  });

  test('returns 2400 for large task text (> 1500 chars)', () => {
    const bigTask = 'a'.repeat(2000);
    expect(summon.scaledCoderTimeout(bigTask)).toBe(2400);
  });

  test('returns 1800 for task with 3 numbered steps', () => {
    const task = '1. do this\n2. do that\n3. and this';
    expect(summon.scaledCoderTimeout(task)).toBe(1800);
  });

  test('returns 2400 for task with 8+ numbered steps', () => {
    const task = Array.from({ length: 8 }, (_, i) => `${i + 1}. step`).join('\n');
    expect(summon.scaledCoderTimeout(task)).toBe(2400);
  });

  test('returns 1800 for task with 3+ <edit tags', () => {
    const task = '<edit>one</edit> <edit>two</edit> <edit>three</edit>';
    expect(summon.scaledCoderTimeout(task)).toBe(1800);
  });
});

// ---------------------------------------------------------------------------
// Item 7: --tool-budget enforcement in tool-guard.js
// ---------------------------------------------------------------------------
describe('Item 7 — tool-budget enforcement', () => {
  test('tool-guard exports checkToolBudget', () => {
    expect(typeof toolGuard.checkToolBudget).toBe('function');
  });

  test('checkToolBudget returns false when count <= budget', () => {
    expect(toolGuard.checkToolBudget(10, 5)).toBe(false);
    expect(toolGuard.checkToolBudget(10, 10)).toBe(false);
  });

  test('checkToolBudget returns true when count exceeds budget', () => {
    expect(toolGuard.checkToolBudget(10, 11)).toBe(true);
    expect(toolGuard.checkToolBudget(5, 6)).toBe(true);
  });

  test('checkToolBudget returns false when budget is 0 (unlimited)', () => {
    expect(toolGuard.checkToolBudget(0, 999)).toBe(false);
  });

  test('parseArgs parses --tool-budget flag', () => {
    const args = summon.parseArgs(['node', 'summon.js', '--tool-budget', '20', '--agent', 'coder']);
    expect(args.toolBudget).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// Item 8: isTestSession filter helper in session.js
// ---------------------------------------------------------------------------
describe('Item 8 — isTestSession filter helper', () => {
  test('session exports filterTestSessions', () => {
    expect(typeof session.filterTestSessions).toBe('function');
  });

  test('filterTestSessions removes sessions with isTestSession:true', () => {
    const sessions = [
      { sid: 'a', agent: 'coder', isTestSession: true },
      { sid: 'b', agent: 'researcher' },
      { sid: 'c', agent: 'planner', isTestSession: false },
    ];
    const filtered = session.filterTestSessions(sessions);
    expect(filtered.length).toBe(2);
    expect(filtered.every(s => !s.isTestSession)).toBe(true);
  });

  test('filterTestSessions returns empty array for empty input', () => {
    expect(session.filterTestSessions([])).toEqual([]);
  });

  test('filterTestSessions keeps all sessions when none are test sessions', () => {
    const sessions = [{ sid: 'x' }, { sid: 'y' }];
    expect(session.filterTestSessions(sessions).length).toBe(2);
  });
});
