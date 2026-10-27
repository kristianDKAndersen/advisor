const { test, expect, afterAll } = require('bun:test');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-revert-check');
const scratch = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(repo, files) {
  for (const [name, content] of Object.entries(files)) {
    const p = join(repo, name);
    if (content === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

// Throwaway repo with a base commit (`baseFiles`) and a head commit (`headFiles`
// applied on top; null deletes). Returns { dir, repo, base, head }.
function makeRepo(baseFiles, headFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'revert-check-test-'));
  scratch.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  put(repo, baseFiles);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  put(repo, headFiles);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  return { dir, repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

function run(fx, testCmd, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, '--base', fx.base, '--head', fx.head, '--test-cmd', testCmd, '--json', ...extra], { encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report };
}

// validate() gains a guard in the head commit; one -U0 hunk.
const VALIDATE_BASE = 'validate() {\n  echo "validated $1"\n}\n';
const VALIDATE_HEAD = 'validate() {\n  [ -n "$1" ] || return 1\n  echo "validated $1"\n}\n';
const guardRepo = (runner) => makeRepo({ 'src/validate.sh': VALIDATE_BASE, 'tests/run.sh': runner }, { 'src/validate.sh': VALIDATE_HEAD });

const ASSERTING_RUNNER = '. ./src/validate.sh\nif validate ""; then\n  echo "(fail) validate rejects empty input"\n  exit 1\nfi\necho "(pass) validate rejects empty input"\n';
const COUNTING_RUNNER = '. ./src/validate.sh\ncalls=0\nvalidate ""\ncalls=$((calls+1))\n[ "$calls" -eq 1 ] || exit 1\n';
const SH_TEST = 'sh tests/run.sh';

const worktrees = (repo) => git(repo, 'worktree', 'list');

test('bare invocation prints usage and exits 2; an unresolvable ref exits 4', () => {
  const bare = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  expect(bare.status).toBe(2);
  expect(bare.stdout).toContain('Usage: advisor-revert-check');
  const missing = spawnSync(process.execPath, [SCRIPT, '--repo', tmpdir()], { encoding: 'utf8' });
  expect(missing.status).toBe(2);
  const fx = guardRepo(ASSERTING_RUNNER);
  const bad = run({ ...fx, base: 'no-such-ref' }, SH_TEST);
  expect(bad.status).toBe(4);
});

test('an added guard with an asserting test is KILLED (exit 0)', () => {
  const fx = guardRepo(ASSERTING_RUNNER);
  const out = run(fx, SH_TEST);
  expect(out.status).toBe(0);
  expect(out.report.hunks).toHaveLength(1);
  expect(out.report.hunks[0]).toMatchObject({ file: 'src/validate.sh', old_start: 1, new_start: 2, added: 1, removed: 0, status: 'KILLED' });
  expect(out.report.base).toBe(fx.base);
  expect(out.report.head).toBe(fx.head);
  expect(out.report.test_cmd).toBe(SH_TEST);
});

test('a KILLED hunk excerpt names the failing test (verbatim failure line, else the output tail)', () => {
  const named = run(guardRepo(ASSERTING_RUNNER), SH_TEST);
  expect(named.report.hunks[0].status).toBe('KILLED');
  expect(named.report.hunks[0].excerpt).toContain('(fail) validate rejects empty input');
  expect(named.report.hunks[0].excerpt).not.toContain('(pass)');
  const unnamed = run(guardRepo('. ./src/validate.sh\nif validate ""; then echo "boom: expected 1 got 0"; exit 1; fi\n'), SH_TEST);
  expect(unnamed.report.hunks[0].status).toBe('KILLED');
  expect(unnamed.report.hunks[0].excerpt).toContain('boom: expected 1 got 0');
});

test('an added guard whose test only counts calls is SURVIVED (exit 1)', () => {
  const out = run(guardRepo(COUNTING_RUNNER), SH_TEST);
  expect(out.status).toBe(1);
  expect(out.report.hunks.map((h) => h.status)).toEqual(['SURVIVED']);
});

test('a hunk whose revert breaks an import is ERROR, and a hung revert is TIMEOUT (both exit 1)', () => {
  const fx = makeRepo(
    { 'src/app.js': "const dep = require('./dep-old.js');\nmodule.exports = dep.v;\n", 'src/dep-old.js': 'exports.v = 1;\n', 'tests/run.js': "if (require('../src/app.js') !== 1) { console.log('(fail) app loads dep'); process.exit(1); }\n" },
    { 'src/app.js': "const dep = require('./dep.js');\nmodule.exports = dep.v;\n", 'src/dep.js': 'exports.v = 1;\n', 'src/dep-old.js': null },
  );
  const out = run(fx, `${JSON.stringify(process.execPath)} tests/run.js`);
  expect(out.status).toBe(1);
  const app = out.report.hunks.find((h) => h.file === 'src/app.js');
  expect(app.status).toBe('ERROR');
  expect(app.excerpt).toContain('Cannot find module');

  const hang = guardRepo('. ./src/validate.sh\nif validate ""; then sleep 30; fi\n');
  const started = Date.now();
  const timed = run(hang, SH_TEST, ['--timeout-per-run', '1']);
  expect(timed.status).toBe(1);
  expect(timed.report.hunks.map((h) => h.status)).toEqual(['TIMEOUT']);
  expect(Date.now() - started).toBeLessThan(15000);
});

test('a red baseline exits 3 and runs no hunk', () => {
  const fx = guardRepo(ASSERTING_RUNNER);
  const out = run(fx, 'echo "(fail) baseline is red"; exit 1');
  expect(out.status).toBe(3);
  expect(out.report.error).toContain('BASELINE_RED');
  expect(out.report.excerpt).toContain('(fail) baseline is red');
  expect(out.report.hunks.every((h) => h.status === 'NOT_RUN')).toBe(true);
});

test('--max-hunks 1 with 2 hunks exits 5; --allow-partial runs one and lists the other NOT_RUN', () => {
  const lines = (a, b) => ['l1', a, 'l3', 'l4', 'l5', 'l6', 'l7', b, 'l9', 'l10'].join('\n') + '\n';
  const fx = makeRepo({ 'src/two.txt': lines('a', 'b') }, { 'src/two.txt': lines('A', 'B') });
  const over = run(fx, 'true', ['--max-hunks', '1']);
  expect(over.status).toBe(5);
  expect(over.report.hunks.map((h) => h.status)).toEqual(['NOT_RUN', 'NOT_RUN']);
  const partial = run(fx, 'true', ['--max-hunks', '1', '--allow-partial']);
  expect(partial.report.hunks.map((h) => h.status)).toEqual(['SURVIVED', 'NOT_RUN']);
  expect(partial.status).toBe(1);
});

test('test files and *.md are excluded by default; --include and --exclude adjust the set', () => {
  const files = { 'src/real.sh': 'echo 1\n', 'tests/foo.test.js': 'a\n', 'test/helper.sh': 'a\n', 'lib/x_test.py': 'a\n', 'lib/a.test.js': 'a\n', 'test-run.sh': 'a\n', 'README.md': 'a\n', 'docs/guide.md': 'a\n' };
  const edited = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `${v}more\n`]));
  const fx = makeRepo(files, edited);
  const names = (extra) => run(fx, 'true', extra).report.hunks.map((h) => h.file).sort();
  expect(names([])).toEqual(['src/real.sh']);
  expect(names(['--include', 'src/*,README.md'])).toEqual(['README.md', 'src/real.sh']);
  expect(names(['--include', '*.md'])).toEqual(['README.md', 'docs/guide.md']);
  const none = run(fx, 'true', ['--exclude', 'src/*']);
  expect(none.report.hunks).toEqual([]);
  expect(none.status).toBe(0);
});

test('git worktree list is unchanged after a pass, after a failure and after SIGINT', async () => {
  const fx = guardRepo(ASSERTING_RUNNER);
  const before = worktrees(fx.repo);
  expect(run(fx, SH_TEST).status).toBe(0);
  expect(worktrees(fx.repo)).toBe(before);
  expect(run(fx, 'exit 1').status).toBe(3);
  expect(worktrees(fx.repo)).toBe(before);

  const marker = join(fx.dir, 'started');
  const child = spawn(process.execPath, [SCRIPT, '--repo', fx.repo, '--base', fx.base, '--head', fx.head, '--test-cmd', `touch ${JSON.stringify(marker)}; sleep 30`], { stdio: 'ignore' });
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  const deadline = Date.now() + 15000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(marker)).toBe(true);
  expect(worktrees(fx.repo)).not.toBe(before);
  const t0 = Date.now();
  child.kill('SIGINT');
  const res = await exited;
  expect(res.code).toBe(130);
  expect(Date.now() - t0).toBeLessThan(10000);
  expect(worktrees(fx.repo)).toBe(before);
}, 30000);

test("the source checkout's git status --porcelain is identical before and after", () => {
  const fx = guardRepo(ASSERTING_RUNNER);
  writeFileSync(join(fx.repo, 'untracked.txt'), 'scratch\n');
  writeFileSync(join(fx.repo, 'src', 'validate.sh'), `${VALIDATE_HEAD}# local edit\n`);
  const before = git(fx.repo, 'status', '--porcelain');
  expect(before).toContain('untracked.txt');
  const out = run(fx, SH_TEST, ['--out', join(fx.dir, 'report.json')]);
  expect(out.status).toBe(0);
  expect(git(fx.repo, 'status', '--porcelain')).toBe(before);
  expect(readFileSync(join(fx.repo, 'untracked.txt'), 'utf8')).toBe('scratch\n');
  expect(JSON.parse(readFileSync(join(fx.dir, 'report.json'), 'utf8')).hunks[0].status).toBe('KILLED');
});

test('zero selected hunks exits 0 but flags no_hunks in JSON, on stderr and in the table', () => {
  const fx = makeRepo({ 'README.md': 'a\n' }, { 'README.md': 'a\nb\n' });
  const json = run(fx, 'true');
  expect(json.status).toBe(0);
  expect(json.report.hunks).toEqual([]);
  expect(json.report.no_hunks).toBe(true);
  expect(json.stderr).toContain('NO_HUNKS: 0 hunks selected (check --base/--include)');
  const text = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, '--base', fx.base, '--head', fx.head, '--test-cmd', 'true'], { encoding: 'utf8' });
  expect(text.status).toBe(0);
  expect(text.stdout).toContain('NO_HUNKS: 0 hunks selected (check --base/--include)');
  expect(run(guardRepo(ASSERTING_RUNNER), SH_TEST).report.no_hunks).toBeUndefined();
});
