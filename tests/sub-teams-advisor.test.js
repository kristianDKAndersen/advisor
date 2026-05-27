// Sub-teams advisor integration tests
// Wave 1 (U0): written first as failing tests
// Wave 2 (U6): --sub-team flag wiring tests pass after bin/summon + lib/summon.js changes
import { test, expect, describe, afterEach, beforeAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = path.join(import.meta.dir, '..');
const SUMMON_JS = path.join(REPO, 'lib', 'summon.js');

// Track session dirs created during tests for cleanup
const createdSids = [];

function cleanupAll() {
  for (const sid of createdSids.splice(0)) {
    try { fs.rmSync(path.join(process.env.HOME, '.advisor', 'runs', sid), { recursive: true, force: true }); } catch (_) {}
  }
}

beforeAll(() => {
  process.on('exit', cleanupAll);
  process.on('SIGINT', () => { cleanupAll(); process.exit(1); });
});

function runSummon(extraArgs = []) {
  const args = [
    SUMMON_JS,
    '--agent', 'coder',
    '--task', 'Test task T',
    '--goal', 'Test goal G',
    ...extraArgs,
  ];
  const result = execFileSync('node', args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
  const meta = JSON.parse(result);
  createdSids.push(meta.sid);
  return meta;
}

afterEach(() => {
  // Clean up created git worktrees and session dirs
  for (const sid of createdSids.splice(0)) {
    try {
      execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', `ws/${sid}`], {
        stdio: 'ignore',
      });
    } catch (_) {}
    try {
      const sessionDir = path.join(process.env.HOME, '.advisor', 'runs', sid);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

// ============================================================================
// U0/U1: Sub-teams lib files exist (Wave 2 implementation test)
// ============================================================================

describe('sub-teams lib files exist', () => {
  test('claim.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'claim.js'))).toBe(true);
  });
  test('complete.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'complete.js'))).toBe(true);
  });
  test('fail.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'fail.js'))).toBe(true);
  });
  test('inbox.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'inbox.js'))).toBe(true);
  });
  test('init.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'init.js'))).toBe(true);
  });
  test('reclaim.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'reclaim.js'))).toBe(true);
  });
  test('state.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'state.js'))).toBe(true);
  });
  test('build-prompts.js exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'lib', 'build-prompts.js'))).toBe(true);
  });
  test('package.json exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'package.json'))).toBe(true);
  });
  test('agents/delegator.md exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'agents', 'delegator.md'))).toBe(true);
  });
  test('agents/teammate.md exists', () => {
    expect(fs.existsSync(path.join(REPO, 'sub-teams', 'agents', 'teammate.md'))).toBe(true);
  });
  test('skills/sub-teams/SKILL.md exists', () => {
    expect(fs.existsSync(path.join(REPO, 'skills', 'sub-teams', 'SKILL.md'))).toBe(true);
  });
});

// ============================================================================
// U6: --sub-team flag wiring — bootstrap prompt injection
// ============================================================================

describe('--sub-team bootstrap injection', () => {
  test('summon --sub-team exits 0 and produces valid JSON', () => {
    let meta;
    expect(() => { meta = runSummon(['--sub-team']); }).not.toThrow();
    expect(meta).toHaveProperty('sid');
    expect(meta).toHaveProperty('promptFile');
    expect(meta).toHaveProperty('workspace');
  });

  test('promptFile contains "Sub-Team Mode" when --sub-team is passed', () => {
    const meta = runSummon(['--sub-team']);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).toContain('Sub-Team Mode');
  });

  test('promptFile contains "sub_team_run_id" when --sub-team is passed', () => {
    const meta = runSummon(['--sub-team']);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).toContain('sub_team_run_id');
  });

  test('workspace contains .claude/skills/sub-teams/SKILL.md when --sub-team', () => {
    const meta = runSummon(['--sub-team']);
    const skillPath = path.join(meta.workspace, '.claude', 'skills', 'sub-teams', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  test('promptFile does NOT contain "Sub-Team Mode" without --sub-team (regression)', () => {
    const meta = runSummon([]);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).not.toContain('Sub-Team Mode');
  });
});

// ============================================================================
// U7: --sub-team-model flag — model directive in bootstrap prompt
// ============================================================================

describe('--sub-team-model bootstrap injection', () => {
  test('--sub-team alone defaults to sonnet in the prompt', () => {
    const meta = runSummon(['--sub-team']);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).toContain('model: "sonnet"');
  });

  test('--sub-team --sub-team-model sonnet includes sonnet directive', () => {
    const meta = runSummon(['--sub-team', '--sub-team-model', 'sonnet']);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).toContain('model: "sonnet"');
  });

  test('--sub-team --sub-team-model haiku includes haiku directive', () => {
    const meta = runSummon(['--sub-team', '--sub-team-model', 'haiku']);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).toContain('model: "haiku"');
  });

  test('--sub-team --sub-team-model opus includes opus directive', () => {
    const meta = runSummon(['--sub-team', '--sub-team-model', 'opus']);
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).toContain('model: "opus"');
  });

  test('--sub-team-model with invalid value exits non-zero', () => {
    const { execFileSync: exec } = require('child_process');
    expect(() => {
      exec('node', [
        path.join(REPO, 'lib', 'summon.js'),
        '--agent', 'coder',
        '--task', 'T',
        '--goal', 'G',
        '--sub-team',
        '--sub-team-model', 'gpt-4',
      ], { cwd: REPO, encoding: 'utf8', timeout: 10000 });
    }).toThrow();
  });

  test('--sub-team-model without --sub-team is silently ignored (exits 0)', () => {
    // Design choice: silently ignored so callers can always pass --sub-team-model
    // alongside an optional --sub-team without needing to branch.
    let meta;
    expect(() => { meta = runSummon(['--sub-team-model', 'haiku']); }).not.toThrow();
    expect(meta).toHaveProperty('sid');
    const prompt = fs.readFileSync(meta.promptFile, 'utf8');
    expect(prompt).not.toContain('Sub-Team Mode');
  });
});
