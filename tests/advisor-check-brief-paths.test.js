import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'advisor-check-brief-paths');

function run(args, input) {
  const result = spawnSync(SCRIPT, args, { encoding: 'utf8', input: input ?? '' });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adv-brief-paths-test-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

  writeFileSync(join(root, 'CLAUDE.md'), '# claude\n');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'channel.js'), '// channel\n');
  writeFileSync(join(root, '.gitignore'), '/docs\n');
  execFileSync('git', ['add', 'CLAUDE.md', 'lib/channel.js', '.gitignore'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });

  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'evalLoop.md'), '# eval loop rubric\n');

  writeFileSync(join(root, 'lib', 'untracked.js'), '// present on disk, never committed\n');

  return root;
}

describe('advisor-check-brief-paths', () => {
  test('-h/--help prints usage and exits 0 before any filesystem access', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  test('true positive: gitignored path -> invisible, exit 1', () => {
    const root = makeRepo();
    const brief = 'Map onto the exact rubric table in docs/evalLoop.md please.';
    const result = run(['--root', root], brief);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docs/evalLoop.md');
    expect(result.stderr).toMatch(/gitignored/);
  });

  test('true positive: nonexistent path -> invisible, exit 1', () => {
    const root = makeRepo();
    const brief = 'See lib/does-not-exist.js for the implementation.';
    const result = run(['--root', root], brief);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('lib/does-not-exist.js');
    expect(result.stderr).toMatch(/nonexistent/);
  });

  test('true positive: existing-but-untracked path -> invisible, exit 1 (discriminates from plain existsSync)', () => {
    const root = makeRepo();
    const brief = 'Edit lib/untracked.js next.';
    const result = run(['--root', root], brief);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('lib/untracked.js');
    expect(result.stderr).toMatch(/untracked/);
  });

  test('true negative: tracked file -> visible, exit 0', () => {
    const root = makeRepo();
    const brief = 'Update CLAUDE.md and lib/channel.js as needed.';
    const result = run(['--root', root], brief);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('all visible');
  });

  test('prose is not flagged as a path (precision)', () => {
    const root = makeRepo();
    const brief = 'e.g. this is a note, i.e. nothing to see, run it either way. See http://example.com/foo/bar.md for context. Ratio 3/4 is fine.';
    const result = run(['--root', root], brief);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 cited path(s) checked');
  });

  test('absolute paths outside the repo (worker output dirs) are skipped', () => {
    const root = makeRepo();
    const brief = 'Write your changelog to /Users/awesome/.advisor/runs/some-sid/output/changes.md.';
    const result = run(['--root', root], brief);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 cited path(s) checked');
  });

  test('--warn downgrades exit code to 0 but still prints the report', () => {
    const root = makeRepo();
    const brief = 'See docs/evalLoop.md.';
    const result = run(['--root', root, '--warn'], brief);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('docs/evalLoop.md');
  });

  test('--json emits parseable JSON with invisible entries', () => {
    const root = makeRepo();
    const brief = 'See docs/evalLoop.md and lib/channel.js.';
    const result = run(['--root', root, '--json'], brief);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.checked).toBe(2);
    expect(parsed.invisible.some((i) => i.path === 'docs/evalLoop.md')).toBe(true);
  });

  test('--file reads brief text from a file', () => {
    const root = makeRepo();
    const briefPath = join(root, 'brief.txt');
    writeFileSync(briefPath, 'See docs/evalLoop.md.');
    const result = run(['--root', root, '--file', briefPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docs/evalLoop.md');
  });
});
