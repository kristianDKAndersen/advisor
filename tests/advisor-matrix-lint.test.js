const { test, expect, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-matrix-lint');
const scratch = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

// Throwaway repo with one tracked test file holding the test IDs T1 and T2.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-lint-'));
  scratch.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'foo.test.js'), "test('T1 rejects symlink', () => {});\ntest('T2 rejects dotdot path', () => {});\n");
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
  return { dir, repo };
}

const fx = makeRepo();
let n = 0;

function run(md, extra = []) {
  const file = join(fx.dir, `doc${n++}.md`);
  writeFileSync(file, md);
  const r = spawnSync(SCRIPT, ['--file', file, '--repo', fx.repo, ...extra], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const doc = (body) => `## Changes Applied\n\n### Guard matrix\n\n${body}\n\n### Summary\n- Applied: 1/1\n`;

const VALID = [
  '| entry point | symlink | dotdot |',
  '|-------------|---------|--------|',
  '| `cli sub-a` | `T1` | T2 |',
  '| hook b | T1 | N/A: hook never sees relative paths |',
].join('\n');

test('a valid matrix exits 0', () => {
  const r = run(doc(VALID));
  expect(r.status).toBe(0);
  expect(r.out).toContain('2 row(s)');
});

test('a missing matrix with --required exits 3, without it exits 0', () => {
  const md = '## Changes Applied\n\n### Guard matrix: N/A (new read-only CLI, no protected resource)\n\n### Summary\n';
  expect(run(md, ['--required']).status).toBe(3);
  expect(run(md).status).toBe(0);
  expect(run('no headings at all\n', ['--required']).status).toBe(3);
});

test('an empty cell exits 4', () => {
  const r = run(doc(VALID.replace('| T1 | N/A: hook never sees relative paths |', '| T1 |  |')));
  expect(r.status).toBe(4);
  expect(r.out).toContain('EMPTY_CELL');
});

test('one row without a justification exits 4', () => {
  const one = ['| entry point | symlink |', '|---|---|', '| only cli | T1 |'].join('\n');
  expect(run(doc(one)).status).toBe(4);
  expect(run(doc(`${one}\n\nEntry points: 1 (single CLI, no hooks or readers reach the file)`)).status).toBe(0);
});

test('an unknown test ID exits 5', () => {
  const r = run(doc(VALID.replace('| T2 |', '| T99 |')));
  expect(r.status).toBe(5);
  expect(r.out).toContain('T99');
});

test('a bare N/A exits 6', () => {
  expect(run(doc(VALID.replace('N/A: hook never sees relative paths', 'N/A'))).status).toBe(6);
  expect(run(doc(VALID.replace('N/A: hook never sees relative paths', 'N/A: not applicable'))).status).toBe(6);
});

test('a plan matrix of scenarios with --plan exits 0', () => {
  const plan = [
    '| entry point | symlink | dotdot |',
    '|---|---|---|',
    '| cli sub-a | symlink to a protected file is rejected | `../x` resolves outside the root and is rejected |',
    '| hook b | N/A: hook receives absolute paths only | dotdot path in hook payload is rejected |',
  ].join('\n');
  expect(run(doc(plan), ['--plan']).status).toBe(0);
  expect(run(doc(plan)).status).toBe(5);
});

test('a bare invocation prints usage and exits 2', () => {
  const r = spawnSync(SCRIPT, [], { encoding: 'utf8' });
  expect(r.status).toBe(2);
  expect(r.stdout).toContain('Usage: advisor-matrix-lint');
  expect(spawnSync(SCRIPT, ['--help'], { encoding: 'utf8' }).status).toBe(2);
  expect(spawnSync(SCRIPT, ['--bogus'], { encoding: 'utf8' }).status).toBe(2);
});

test('parses a matrix shaped as the coder prompt item 7 describes', () => {
  // rows = entry points or fields, columns = guard x alias, cells = test IDs or N/A: <reason>
  const md = [
    '## Changes Applied',
    '',
    '### Guard matrix',
    '| entry point / field | path check x symlink | path check x case variant | path check x `..` path | path check x tracked vs ignored |',
    '|---|---|---|---|---|',
    '| `lib/summon.js` summon subcommand | T1 | N/A: filesystem is case sensitive here | T2 | T1 |',
    '| `lib/hooks/guard.js` hook | T1 | T1 | T2 | N/A: hook only sees tracked paths |',
    '| `--out` field (twin of `--in`) | T2 | N/A: field is an opaque string | T2 | T1 |',
    '',
    '### Summary',
  ].join('\n');
  const r = run(md, ['--json']);
  expect(r.status).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.matrix).toMatchObject({ rows: 3, columns: 5 });
  expect(j.findings).toEqual([]);
  expect(j.out_of_scope).toEqual([]);
});

test('an OUT OF SCOPE cell is valid, needs no test ID and is reported separately', () => {
  const oos = VALID.replace('| T2 |', '| OUT OF SCOPE: brief excludes lib/ files |');
  const j = JSON.parse(run(doc(oos), ['--json']).out);
  expect(j.exit_code).toBe(0);
  expect(j.findings).toEqual([]);
  expect(j.out_of_scope).toHaveLength(1);
  expect(j.out_of_scope[0]).toMatchObject({ row: 'cli sub-a', column: 'dotdot', boundary: 'brief excludes lib/ files' });
  const text = run(doc(oos));
  expect(text.status).toBe(0);
  expect(text.out).toContain('info out_of_scope row "cli sub-a" column "dotdot": brief excludes lib/ files');
  // without a boundary it is a reasonless marker, like a bare N/A
  expect(run(doc(VALID.replace('| T2 |', '| OUT OF SCOPE: |'))).status).toBe(6);
});
