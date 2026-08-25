import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'advisor-audit-clis');

function run(args) {
  try {
    const out = execFileSync(SCRIPT, args, { encoding: 'utf8' });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'adv-audit-clis-test-'));
}

function writeBinScript(root, name, content) {
  const dir = join(root, 'bin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

const UNGUARDED_PRUNE_CLI = `#!/usr/bin/env bun
const { rmSync } = require('node:fs');
const args = process.argv.slice(2);
const cmd = args[0];
switch (cmd) {
  case 'prune-fixtures':
    rmSync('/tmp/whatever', { recursive: true, force: true });
    break;
  default:
    console.log('unknown command');
}
`;

const GUARDED_PRUNE_CLI = `#!/usr/bin/env bun
const { rmSync } = require('node:fs');
const args = process.argv.slice(2);
const cmd = args[0];
switch (cmd) {
  case 'prune-fixtures':
    if (args.includes('--help') || args.includes('-h')) {
      console.log('Usage: good-cli prune-fixtures');
      process.exit(0);
    }
    rmSync('/tmp/whatever', { recursive: true, force: true });
    break;
  default:
    console.log('unknown command');
}
`;

describe('advisor-audit-clis', () => {
  test('-h prints usage and exits 0 before any filesystem access', () => {
    const result = run(['-h']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: advisor-audit-clis');
  });

  test('--help prints usage and exits 0 before any filesystem access', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: advisor-audit-clis');
  });

  test('true positive: destructive subcommand with no help/dry-run guard -> exit 1, names offender', () => {
    const root = makeRoot();
    writeBinScript(root, 'bad-cli', UNGUARDED_PRUNE_CLI);

    const result = run(['--root', root]);
    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('bad-cli');
    expect(output).toContain('prune-fixtures');
  });

  test('true negative: destructive subcommand with a help short-circuit before the mutating call -> exit 0', () => {
    const root = makeRoot();
    writeBinScript(root, 'good-cli', GUARDED_PRUNE_CLI);

    const result = run(['--root', root]);
    expect(result.code).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('0 unguarded');
  });

  test('non-destructive subcommands are not flagged even without a guard', () => {
    const root = makeRoot();
    writeBinScript(
      root,
      'harmless-cli',
      `#!/usr/bin/env bun
const { rmSync } = require('node:fs');
const cmd = process.argv[2];
switch (cmd) {
  case 'list-items':
    rmSync('/tmp/whatever', { recursive: true, force: true });
    break;
}
`
    );

    const result = run(['--root', root]);
    expect(result.code).toBe(0);
  });

  test('destructive subcommand with no mutating call at all is not flagged', () => {
    const root = makeRoot();
    writeBinScript(
      root,
      'readonly-cli',
      `#!/usr/bin/env bun
const cmd = process.argv[2];
switch (cmd) {
  case 'prune-fixtures':
    console.log('would prune, but this is a stub');
    break;
}
`
    );

    const result = run(['--root', root]);
    expect(result.code).toBe(0);
  });

  test('--json emits parseable JSON with violation details', () => {
    const root = makeRoot();
    writeBinScript(root, 'bad-cli', UNGUARDED_PRUNE_CLI);

    const result = run(['--root', root, '--json']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed.violations)).toBe(true);
    expect(parsed.violations.some((v) => v.subcommand === 'prune-fixtures')).toBe(true);
  });

  test('--json scripts array length matches scanned count and names a known-dispatching script', () => {
    const repoRoot = join(import.meta.dir, '..');
    const result = run(['--root', repoRoot, '--json']);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed.scripts)).toBe(true);
    expect(parsed.scripts.length).toBe(parsed.scanned);
    expect(parsed.scripts).toContain('bin/advisor-vault');
  });

  test('--list prints scanned scripts one per line', () => {
    const root = makeRoot();
    writeBinScript(root, 'bad-cli', UNGUARDED_PRUNE_CLI);

    const result = run(['--root', root, '--list']);
    expect(result.stdout).toContain('bin/bad-cli');
  });
});
