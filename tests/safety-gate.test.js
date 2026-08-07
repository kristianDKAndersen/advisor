const { test, expect } = require('bun:test');
const path = require('path');
const { checkGate, loadGateConfig } = require('../lib/safety-gate');

const fixturePath = path.join(__dirname, 'fixtures', 'safety-gate.example.json');
const gate = loadGateConfig(fixturePath);

test('loadGateConfig reads the fixture shape', () => {
  expect(Array.isArray(gate.path_denylist)).toBe(true);
  expect(gate.on_violation).toBe('halt-escalate');
});

test('allows a clean change with an allowlisted action', () => {
  const gateAllowed = { ...gate, action_allowlist: { ...gate.action_allowlist, git_commit: true } };
  const result = checkGate(gateAllowed, ['src/foo.js'], 'git_commit');
  expect(result).toEqual({ allowed: true });
});

test('denies a path matching the denylist via glob, naming path and matched glob', () => {
  const result = checkGate(gate, ['infra/terraform/main.tf'], 'git_commit');
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.path).toBe('infra/terraform/main.tf');
  expect(result.matched).toBe('infra/**');
  expect(result.action).toBe('git_commit');
});

test('denies a dotenv file anywhere via ** glob', () => {
  const result = checkGate(gate, ['packages/api/.env.production'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.matched).toBe('**/.env*');
});

test('deny-by-default: an action absent from the allowlist is refused', () => {
  const result = checkGate(gate, ['src/foo.js'], 'exec_arbitrary_shell');
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('action_not_allowlisted');
  expect(result.action).toBe('exec_arbitrary_shell');
});

test('deny-by-default: an action explicitly false in the allowlist is refused', () => {
  const result = checkGate(gate, ['src/foo.js'], 'git_push');
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('action_not_allowlisted');
  expect(result.action).toBe('git_push');
});

test('denies a path escaping the declared worktree scope', () => {
  const scoped = { ...gate, worktree_root: '/tmp/advisor-loop-example-run' };
  const result = checkGate(scoped, ['../../etc/passwd'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('outside_worktree');
  expect(result.path).toBe('../../etc/passwd');
});

test('allows a path confined to the declared worktree scope', () => {
  const scoped = { ...gate, worktree_root: '/tmp/advisor-loop-example-run' };
  const result = checkGate(scoped, ['round-0/src/main.js'], null);
  expect(result.allowed).toBe(true);
});

test('violation is a structured object, never a bare boolean', () => {
  const result = checkGate(gate, ['infra/x.tf'], null);
  expect(typeof result).toBe('object');
  expect(result).not.toBe(true);
  expect(result).not.toBe(false);
  expect(result.allowed).toBe(false);
});

// gates/advisor-default.json is the shipped default gate. It is loaded here
// (not copied) so the real file is under test. Its worktree_root is a
// placeholder ("REPLACE_ME_worktree_root_per_run") meant to be overridden
// per run by the loop driver; these tests pass files_changed only (no
// action) so the placeholder never participates in the outside_worktree
// check.
const defaultGatePath = path.join(__dirname, '..', 'gates', 'advisor-default.json');
const defaultGate = loadGateConfig(defaultGatePath);

test('advisor-default gate documents worktree_root as a placeholder to override per run', () => {
  expect(defaultGate.worktree_root).toBe('REPLACE_ME_worktree_root_per_run');
});

test('advisor-default gate denies lowercase claude.md (the tracked root prompt)', () => {
  const result = checkGate(defaultGate, ['claude.md'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.matched).toBe('claude.md');
});

test('advisor-default gate denies uppercase CLAUDE.md (macOS case-insensitive collision with claude.md)', () => {
  const result = checkGate(defaultGate, ['CLAUDE.md'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.matched).toBe('CLAUDE.md');
});

test('advisor-default gate denies a path under spawns/', () => {
  const result = checkGate(defaultGate, ['spawns/coder/CLAUDE.md'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.matched).toBe('spawns/**');
});

test('advisor-default gate denies a path under .claude/', () => {
  const result = checkGate(defaultGate, ['.claude/settings.json'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.matched).toBe('.claude/**');
});

test('advisor-default gate denies a path under gates/ (a loop cannot rewrite its own gate)', () => {
  const result = checkGate(defaultGate, ['gates/advisor-default.json'], null);
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('path_denylist');
  expect(result.matched).toBe('gates/**');
});

test('advisor-default gate still allows a normal source path', () => {
  const result = checkGate(defaultGate, ['lib/foo.js'], null);
  expect(result).toEqual({ allowed: true });
});
