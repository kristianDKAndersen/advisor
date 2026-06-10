// RED tests for Pattern 5.3: default_tools frontmatter fallback in provisionOne.
// DoD: bun test exits 1 because launch.sh doesn't yet read CLAUDE.md frontmatter.
//
// Three scenarios:
//   S1  agent CLAUDE.md has default_tools:[Read,Bash,Grep], no --allowedTools arg
//       → launch.sh MUST contain --allowedTools 'Read,Bash,Grep'  (FAILS until 5.3 lands)
//   S2  agent has default_tools frontmatter + explicit --allowedTools Write
//       → explicit wins; launch.sh has 'Write', not the frontmatter list
//   S3  agent has NO default_tools frontmatter, no explicit flag
//       → launch.sh has NO --allowedTools flag at all

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const ADVISOR_ROOT = path.resolve(import.meta.dir, '..');
const TS = Date.now();

// Isolated tmp dirs — no pollution of ~/.advisor/runs or ~/.claude.json
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-dflt-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-dflt-home-'));

// ── Synthetic agents ──────────────────────────────────────────────────────

const AGENT_WITH = `test-dflt-with-${TS}`;
const agentWithDir = path.join(ADVISOR_ROOT, 'spawns', AGENT_WITH);

const AGENT_WITHOUT = `test-dflt-none-${TS}`;
const agentWithoutDir = path.join(ADVISOR_ROOT, 'spawns', AGENT_WITHOUT);

// Delete any leftover test-dflt-* dirs from previous failed runs before creating new ones.
const spawnsDir = path.join(ADVISOR_ROOT, 'spawns');
for (const entry of fs.readdirSync(spawnsDir)) {
  if (entry.startsWith('test-dflt-')) {
    fs.rmSync(path.join(spawnsDir, entry), { recursive: true, force: true });
  }
}

function doCleanup() {
  fs.rmSync(agentWithDir,    { recursive: true, force: true });
  fs.rmSync(agentWithoutDir, { recursive: true, force: true });
  fs.rmSync(RUNS_TMP,        { recursive: true, force: true });
  fs.rmSync(HOME_TMP,        { recursive: true, force: true });
}

// Register afterAll before creating dirs so cleanup runs even if dir creation succeeds
// but a later step (provision) fails.
afterAll(doCleanup);

// Create agent dirs; if this throws, afterAll still runs cleanup.
try {
  fs.mkdirSync(agentWithDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentWithDir, 'CLAUDE.md'),
    [
      '---',
      'allowed-tools: Read,Bash,Grep',
      '---',
      '',
      '# Test agent with default_tools',
      '',
      'Synthetic fixture — auto-deleted after tests.',
    ].join('\n')
  );

  fs.mkdirSync(agentWithoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentWithoutDir, 'CLAUDE.md'),
    [
      '# Test agent without default_tools',
      '',
      'No frontmatter block. Synthetic fixture — auto-deleted after tests.',
    ].join('\n')
  );
} catch (e) {
  doCleanup();
  throw e;
}

// ── Helper ────────────────────────────────────────────────────────────────

function provision(agentName, extraArgs) {
  const sid = `test-dflt-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const result = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', agentName,
      '--task',  'default-tools test — ignore',
      '--goal',  'test',
      '--sid',   sid,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
    }
  );
  if (result.status !== 0) {
    throw new Error(`summon exited ${result.status}: ${result.stderr}`);
  }
  const meta = JSON.parse(result.stdout.trim());
  const launchSh = fs.readFileSync(meta.launchScript, 'utf8');
  return { meta, launchSh };
}

// Provision all three scenarios. Wrapped in try/finally so that cleanup via
// afterAll is not the only safety net — if provision throws during module load,
// the finally block ensures dirs are removed before re-throwing.
let s1, s2, s3;
try {
  s1 = provision(AGENT_WITH,    []);
  s2 = provision(AGENT_WITH,    ['--allowedTools', 'Write']);
  s3 = provision(AGENT_WITHOUT, []);
} catch (e) {
  doCleanup();
  throw e;
}

// ── Scenario 1: frontmatter default_tools, no explicit --allowedTools ─────

test('S1: summon exits 0 with default_tools frontmatter agent', () => {
  expect(s1).not.toBeNull();
  expect(typeof s1.launchSh).toBe('string');
});

// RED — provisionOne currently ignores CLAUDE.md frontmatter, so no
// --allowedTools is emitted even when frontmatter lists default_tools.
// This test will fail until pattern 5.3 is implemented.
test("S1: launch.sh contains --allowedTools from default_tools frontmatter", () => {
  expect(s1.launchSh).toContain("--allowedTools 'Read,Bash,Grep'");
});

// ── Scenario 2: frontmatter present + explicit --allowedTools Write ───────

test('S2: summon exits 0 with explicit --allowedTools flag', () => {
  expect(s2).not.toBeNull();
  expect(typeof s2.launchSh).toBe('string');
});

test("S2: explicit --allowedTools is present in launch.sh", () => {
  expect(s2.launchSh).toContain("--allowedTools 'Write'");
});

test('S2: frontmatter list is absent when explicit --allowedTools is supplied', () => {
  expect(s2.launchSh).not.toContain('Read,Bash,Grep');
});

// ── Scenario 3: no default_tools frontmatter, no explicit --allowedTools ──

test('S3: summon exits 0 for agent without default_tools frontmatter', () => {
  expect(s3).not.toBeNull();
  expect(typeof s3.launchSh).toBe('string');
});

test('S3: launch.sh has no --allowedTools when no frontmatter and no explicit flag', () => {
  expect(s3.launchSh).not.toContain('--allowedTools');
});
