const { test, expect, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync, utimesSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-repo-hygiene');
const scratch = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// <base>/repo is the target repo; the CLI sees TMPDIR=<base>/tmp and
// ADVISOR_RUNS_ROOT=<base>/runs, so anything else under <base> is "outside".
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'repo-hygiene-test-')));
  scratch.push(base);
  const ctx = { base, repo: join(base, 'repo'), tmp: join(base, 'tmp'), runs: join(base, 'runs') };
  for (const d of [ctx.repo, ctx.tmp, ctx.runs]) mkdirSync(d);
  git(ctx.repo, 'init', '-q');
  writeFileSync(join(ctx.repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(ctx.repo, 'a.txt'), 'a\n');
  git(ctx.repo, 'add', '-A');
  git(ctx.repo, 'commit', '-q', '-m', 'init');
  return ctx;
}

function run(ctx, args, { env = {}, cwd = ctx.base } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: ctx.tmp, ADVISOR_RUNS_ROOT: ctx.runs, ...env }
  });
  let json = null;
  if (args.includes('--json')) json = JSON.parse(r.stdout);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const worktrees = (repo) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));

function addDetached(ctx, dir, ageHours = 0) {
  git(ctx.repo, 'worktree', 'add', '-q', '--detach', dir);
  if (ageHours) {
    const t = Date.now() / 1000 - ageHours * 3600;
    utimesSync(dir, t, t);
  }
  return dir;
}

const rules = (r) => r.json.findings.map((f) => `${f.rule} ${f.path}`);

test('TRACKED_RESIDUE: a .gitignore whose only diff is .advisor-output/ exits 1, and --execute restores it and exits 0', () => {
  const ctx = setup();
  const gi = join(ctx.repo, '.gitignore');
  appendFileSync(gi, '.advisor-output/\n');
  const dry = run(ctx, ['--repo', ctx.repo, '--json']);
  expect(dry.code).toBe(1);
  expect(rules(dry)).toEqual(['TRACKED_RESIDUE .gitignore']);
  expect(dry.json.findings[0].command).toContain('checkout HEAD -- .gitignore');
  const exec = run(ctx, ['--repo', ctx.repo, '--execute', '--json']);
  expect(exec.code).toBe(0);
  expect(readFileSync(gi, 'utf8')).toBe('node_modules/\n');
  expect(git(ctx.repo, 'status', '--porcelain')).toBe('');
});

test('TRACKED_RESIDUE: a .gitignore that also has a user line is reported and left byte-identical by --execute', () => {
  const ctx = setup();
  const gi = join(ctx.repo, '.gitignore');
  appendFileSync(gi, 'dist/\n.advisor-output/\n');
  const before = readFileSync(gi);
  const exec = run(ctx, ['--repo', ctx.repo, '--execute', '--json']);
  expect(exec.code).toBe(1);
  expect(rules(exec)).toEqual(['TRACKED_RESIDUE .gitignore']);
  expect(exec.json.findings[0].fixable).toBe(false);
  expect(exec.json.actions).toEqual([]);
  expect(readFileSync(gi).equals(before)).toBe(true);
});

test('STALE_WORKTREE: a detached temp worktree older than the max age exits 1, and --execute removes it from git worktree list', () => {
  const ctx = setup();
  const wt = addDetached(ctx, join(ctx.tmp, 'wt-old'), 48);
  const dry = run(ctx, ['--repo', ctx.repo, '--json']);
  expect(dry.code).toBe(1);
  expect(rules(dry)).toEqual([`STALE_WORKTREE ${wt}`]);
  const exec = run(ctx, ['--repo', ctx.repo, '--execute']);
  expect(exec.code).toBe(0);
  expect(worktrees(ctx.repo)).not.toContain(wt);
  expect(existsSync(wt)).toBe(false);
});

test('STALE_WORKTREE: a deleted temp worktree path is pruned by --execute', () => {
  const ctx = setup();
  const wt = addDetached(ctx, join(ctx.tmp, 'wt-gone'));
  rmSync(wt, { recursive: true, force: true });
  const dry = run(ctx, ['--repo', ctx.repo, '--json']);
  expect(dry.code).toBe(1);
  expect(dry.json.findings[0].command).toContain('worktree prune');
  const exec = run(ctx, ['--repo', ctx.repo, '--execute']);
  expect(exec.code).toBe(0);
  expect(worktrees(ctx.repo)).not.toContain(wt);
});

test('STALE_WORKTREE: a ws/<sid> worktree with a live runner pid is untouched', () => {
  const ctx = setup();
  const sid = '1700000000-abc123';
  const wt = join(ctx.runs, sid, 'workspace');
  git(ctx.repo, 'worktree', 'add', '-q', '-b', `ws/${sid}`, wt);
  rmSync(wt, { recursive: true, force: true });
  const runner = join(ctx.runs, sid, 'runner.json');
  writeFileSync(runner, JSON.stringify({ pid: process.pid }));
  const live = run(ctx, ['--repo', ctx.repo, '--execute', '--json']);
  expect(live.code).toBe(0);
  expect(live.json.findings).toEqual([]);
  expect(live.json.actions).toEqual([]);
  expect(worktrees(ctx.repo)).toContain(wt);
  // Control: the same worktree with a dead (reaped) runner pid is pruned.
  const dead = spawnSync('true').pid;
  writeFileSync(runner, JSON.stringify({ pid: dead }));
  const exec = run(ctx, ['--repo', ctx.repo, '--execute']);
  expect(exec.code).toBe(0);
  expect(worktrees(ctx.repo)).not.toContain(wt);
});

test('STALE_WORKTREE: a recent temp worktree is not reported', () => {
  const ctx = setup();
  addDetached(ctx, join(ctx.tmp, 'wt-new'));
  const r = run(ctx, ['--repo', ctx.repo, '--json']);
  expect(r.code).toBe(0);
  expect(r.json.findings).toEqual([]);
});

test('UNIGNORED_ARTIFACT: an unignored .advisor-output/x exits 1, and --execute adds the exclude line', () => {
  const ctx = setup();
  mkdirSync(join(ctx.repo, '.advisor-output'));
  writeFileSync(join(ctx.repo, '.advisor-output', 'x'), 'x\n');
  const dry = run(ctx, ['--repo', ctx.repo, '--json']);
  expect(dry.code).toBe(1);
  expect(rules(dry)).toEqual(['UNIGNORED_ARTIFACT .advisor-output/']);
  const exec = run(ctx, ['--repo', ctx.repo, '--execute']);
  expect(exec.code).toBe(0);
  const exclude = readFileSync(join(ctx.repo, '.git', 'info', 'exclude'), 'utf8').split('\n');
  expect(exclude).toContain('.advisor-output/');
  expect(git(ctx.repo, 'status', '--porcelain')).toBe('');
});

test('clean repo exits 0', () => {
  const ctx = setup();
  const r = run(ctx, ['--repo', ctx.repo]);
  expect(r.code).toBe(0);
});

test('bare invocation exits 2', () => {
  const ctx = setup();
  expect(run(ctx, []).code).toBe(2);
});

test('dry run (no --execute) changes nothing: status, worktree list and exclude file are byte-identical', () => {
  const ctx = setup();
  appendFileSync(join(ctx.repo, '.gitignore'), '.advisor-preserved/\n');
  addDetached(ctx, join(ctx.tmp, 'wt-old'), 48);
  rmSync(addDetached(ctx, join(ctx.tmp, 'wt-gone')), { recursive: true, force: true });
  mkdirSync(join(ctx.repo, '.advisor-output'));
  writeFileSync(join(ctx.repo, '.advisor-output', 'x'), 'x\n');
  const exclude = join(ctx.repo, '.git', 'info', 'exclude');
  const snap = () => [
    git(ctx.repo, 'status', '--porcelain', '-uall'),
    git(ctx.repo, 'worktree', 'list', '--porcelain'),
    existsSync(exclude) ? readFileSync(exclude, 'utf8') : null,
    readFileSync(join(ctx.repo, '.gitignore'), 'utf8')
  ];
  const before = snap();
  const r = run(ctx, ['--repo', ctx.repo, '--json']);
  expect(r.code).toBe(1);
  expect(r.json.findings.map((f) => f.rule).sort()).toEqual(['STALE_WORKTREE', 'STALE_WORKTREE', 'TRACKED_RESIDUE', 'UNIGNORED_ARTIFACT']);
  expect(r.json.actions).toEqual([]);
  expect(snap()).toEqual(before);
});

test('--execute never removes the main worktree or a worktree outside the temp dir and runs root', () => {
  const ctx = setup();
  const outside = addDetached(ctx, join(ctx.base, 'outside-old'), 48);
  const outsideGone = addDetached(ctx, join(ctx.base, 'outside-gone'));
  rmSync(outsideGone, { recursive: true, force: true });
  const stale = addDetached(ctx, join(ctx.tmp, 'wt-old'), 48);
  const staleGone = addDetached(ctx, join(ctx.tmp, 'wt-gone'));
  rmSync(staleGone, { recursive: true, force: true });
  const r = run(ctx, ['--repo', ctx.repo, '--execute', '--json']);
  // The prune would also drop outside-gone, so it is skipped and wt-gone stays reported.
  expect(r.code).toBe(1);
  expect(rules(r)).toEqual([`STALE_WORKTREE ${staleGone}`]);
  const left = worktrees(ctx.repo);
  expect(left).toEqual(expect.arrayContaining([ctx.repo, outside, outsideGone, staleGone]));
  expect(left).not.toContain(stale);
  expect(existsSync(outside)).toBe(true);
});

test('aliases: a symlinked TMPDIR and a relative --repo still match worktrees by realpath', () => {
  const ctx = setup();
  const link = join(ctx.base, 'tmplink');
  symlinkSync(ctx.tmp, link);
  const viaReal = addDetached(ctx, join(ctx.tmp, 'wt-real'), 48);
  const viaLink = addDetached(ctx, join(link, 'wt-link'), 48);
  const r = run(ctx, ['--repo', 'repo', '--json'], { env: { TMPDIR: link } });
  expect(r.code).toBe(1);
  expect(r.json.findings.length).toBe(2);
  const exec = run(ctx, ['--repo', 'repo', '--execute'], { env: { TMPDIR: link } });
  expect(exec.code).toBe(0);
  expect(existsSync(viaReal)).toBe(false);
  expect(existsSync(viaLink)).toBe(false);
});
