import { describe, test, expect, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const SUMMON_PATH = join(REPO_ROOT, 'lib', 'summon.js');

// Provisions a real launch.sh via the actual lib/summon.js template code
// (provisionOne), inside an isolated ADVISOR_RUNS_ROOT so no real session
// state is touched.
function provisionLaunchScript(runsRoot, sid) {
  const helperDir = mkdtempSync(join(tmpdir(), 'summon-helper-'));
  const fakeCwd = mkdtempSync(join(tmpdir(), 'summon-cwd-'));
  const helper = join(helperDir, 'provision.js');
  writeFileSync(
    helper,
    `const summon = require(${JSON.stringify(SUMMON_PATH)});
const result = summon.provisionOne({
  agent: 'researcher',
  task: 'test task',
  goal: 'test goal',
  cwd: ${JSON.stringify(fakeCwd)},
  isTestSession: true,
}, ${JSON.stringify(sid)});
console.log(JSON.stringify({ launchScript: result.launchScript, outbox: result.outbox, sid: result.sid }));
`
  );
  const out = execFileSync('bun', [helper], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_RUNS_ROOT: runsRoot },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function makeStubClaude(binDir, stderrMarker) {
  const claudeStub = join(binDir, 'claude');
  writeFileSync(
    claudeStub,
    `#!/usr/bin/env bash\necho '${stderrMarker}' >&2\nexit 1\n`
  );
  chmodSync(claudeStub, 0o755);
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('launch.sh wrapper: silent-death diagnosability', () => {
  let runsRoot;
  let binDir;

  afterEach(() => {
    if (runsRoot) rmSync(runsRoot, { recursive: true, force: true });
    if (binDir) rmSync(binDir, { recursive: true, force: true });
  });

  test('claude dying at startup still persists stderr and appends a failure envelope', () => {
    runsRoot = mkdtempSync(join(tmpdir(), 'adv-runs-test-'));
    binDir = mkdtempSync(join(tmpdir(), 'adv-stub-bin-'));
    const sid = `launchtest${Date.now()}`;
    const stderrMarker = 'boom-startup-failure-marker-xyz';
    makeStubClaude(binDir, stderrMarker);

    const { launchScript, outbox } = provisionLaunchScript(runsRoot, sid);
    const launchStderrLog = join(launchScript, '..', 'launch-stderr.log');

    // Stub `claude` shadows the real binary; real `bun` stays on PATH so the
    // wrapper's own ensure-result call is exercised for real.
    try {
      execFileSync('bash', [launchScript], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      });
    } catch (_) {
      // launch.sh's own `|| true`/trap guards mean it should not throw, but
      // tolerate a nonzero exit from the wrapper itself either way.
    }

    // 1. stderr persisted durably (never rm'd on exit).
    expect(existsSync(launchStderrLog)).toBe(true);
    const logContent = readFileSync(launchStderrLog, 'utf8');
    expect(logContent).toContain(stderrMarker);

    // 2. outbox gained a failure envelope whose body contains the stderr tail.
    expect(existsSync(outbox)).toBe(true);
    const msgs = readJsonl(outbox);
    const resultMsg = msgs.find((m) => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    expect(resultMsg.body.verdict).toBe('blocked');
    expect(JSON.stringify(resultMsg.body)).toContain(stderrMarker);
  });
});
