const { test, expect, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-claims-check');
const scratch = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitAll(repo, msg) {
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

// Throwaway repo with a 5-line script and a tracked test file; returns the
// repo path plus the first commit sha (`sha`). A second commit is optional.
function makeRepo({ secondCommit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claims-check-'));
  scratch.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'x.sh'), '#!/bin/sh\n# guard\n[ -n "$1" ] || exit 1\necho ok\nexit 0\n');
  writeFileSync(join(repo, 'tests', 'foo.test.js'), "test('T1 asserts the guard', () => {});\n");
  git(repo, 'init', '-q');
  const first = commitAll(repo, 'first');
  let sha = first;
  if (secondCommit) {
    writeFileSync(join(repo, 'scripts', 'y.sh'), 'echo y\n');
    sha = commitAll(repo, 'second');
  }
  return { dir, repo, first, sha };
}

function table(rows) {
  const lines = ['| id | sentence | evidence_type | evidence | sha |', '|----|----------|---------------|----------|-----|'];
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n') + '\n';
}

function write(dir, name, content) {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function run(fx, { rows = [], text, prior = [], report, extra = [] }) {
  const claims = write(fx.dir, 'claims.md', table(rows));
  const args = ['--repo', fx.repo, '--claims', claims, '--json'];
  args.push('--text', write(fx.dir, 'text.md', text));
  prior.forEach((p, i) => args.push('--prior', write(fx.dir, `prior${i}.md`, p)));
  if (report) args.push('--revert-report', write(fx.dir, 'report.json', JSON.stringify(report)));
  args.push(...extra);
  const r = spawnSync('bun', [SCRIPT, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, stderr: r.stderr };
}

const rules = (res) => (res.json ? res.json.findings.map((f) => f.rule) : []);

test('every sentence covered, at HEAD: exit 0', () => {
  const fx = makeRepo();
  const s = 'The guard rejects bad input at scripts/x.sh:3.';
  const res = run(fx, {
    text: `${s}\n`,
    rows: [['C1', s, 'file_line', 'scripts/x.sh:3 "exit 1"', fx.sha]],
  });
  expect(res.code).toBe(0);
  expect(res.json.findings).toEqual([]);
});

test('one row at an older SHA: exit 3 STALE_LEDGER', () => {
  const fx = makeRepo({ secondCommit: true });
  const s = 'The guard rejects bad input at scripts/x.sh:3.';
  const res = run(fx, {
    text: `${s}\n`,
    rows: [['C1', s, 'file_line', 'scripts/x.sh:3', fx.first]],
  });
  expect(res.code).toBe(3);
  expect(rules(res)).toContain('STALE_LEDGER');
});

test('"All 8 findings are fixed in 870ef59." with test evidence: exit 4 (A:F38)', () => {
  const fx = makeRepo();
  const s = 'All 8 findings are fixed in 870ef59.';
  const res = run(fx, {
    text: `${s}\n`,
    rows: [['C1', s, 'test', 'T1 asserts the guard', fx.sha]],
  });
  expect(res.code).toBe(4);
  expect(rules(res)).toEqual(['ABSOLUTE_NOT_EXHAUSTIVE']);
});

test('"The `validate --strict` sentence is exact." without exhaustive evidence: exit 4 (A:F77)', () => {
  const fx = makeRepo();
  const s = 'The `validate --strict` sentence is exact.';
  const res = run(fx, {
    text: `${s}\n`,
    rows: [['C1', s, 'file_line', 'scripts/x.sh:3', fx.sha]],
  });
  expect(res.code).toBe(4);
  expect(rules(res)).toEqual(['ABSOLUTE_NOT_EXHAUSTIVE']);
});

test('a text citing scripts/x.sh:999, past the end of the file: exit 5', () => {
  const fx = makeRepo();
  const s = 'The guard lives at scripts/x.sh:999.';
  const res = run(fx, {
    text: `${s}\n`,
    rows: [['C1', s, 'file_line', 'scripts/x.sh:3', fx.sha]],
  });
  expect(res.code).toBe(5);
  expect(rules(res)).toEqual(['DANGLING_CITE']);
});

test('a text citing docs/contract.md, which does not exist: exit 5 (A:F36)', () => {
  const fx = makeRepo();
  const res = run(fx, { text: 'See docs/contract.md for the contract.\n' });
  expect(res.code).toBe(5);
  expect(rules(res)).toEqual(['DANGLING_CITE']);
});

test('a "fixed" claim whose test SURVIVED in the revert report: exit 6', () => {
  const fx = makeRepo();
  const s = 'The empty-argument bug is fixed in scripts/x.sh:3.';
  const rows = [['C1', s, 'test', 'T1 asserts the guard', fx.sha]];
  const hunk = (status) => ({
    file: 'scripts/x.sh',
    old_start: 3,
    new_start: 3,
    added: 1,
    removed: 0,
    status,
    excerpt: 'FAIL T1 asserts the guard',
  });
  const survived = run(fx, { text: `${s}\n`, rows, report: { base: 'a', head: 'b', test_cmd: 'x', hunks: [hunk('SURVIVED')] } });
  expect(survived.code).toBe(6);
  expect(rules(survived)).toEqual(['UNPROVEN_FIX']);
  const killed = run(fx, { text: `${s}\n`, rows, report: { base: 'a', head: 'b', test_cmd: 'x', hunks: [hunk('KILLED')] } });
  expect(killed.code).toBe(0);
});

test('a prior reply "the band and the banner agree" with no prior: row: exit 7 (A:F42)', () => {
  const fx = makeRepo();
  const s = 'The band and the banner agree.';
  const prior = [`${s}\n`];
  const unchecked = run(fx, { text: 'Nothing assertive here.\n', prior });
  expect(unchecked.code).toBe(7);
  expect(rules(unchecked)).toEqual(['PRIOR_UNCHECKED']);
  const checked = run(fx, {
    text: 'Nothing assertive here.\n',
    prior,
    rows: [['prior:1', s, 'exhaustive', 'scripts/x.sh:3; scripts/x.sh:4', fx.sha]],
  });
  expect(checked.code).toBe(0);
});

test('a code fence containing "all" is ignored', () => {
  const fx = makeRepo();
  const fenced = run(fx, { text: 'Plain words here.\n\n```\nAll tests always pass.\n```\n' });
  expect(fenced.code).toBe(0);
  const bare = run(fx, { text: 'Plain words here.\n\nAll tests always pass.\n' });
  expect(bare.code).toBe(4);
});

test('"e.g." does not split a sentence', () => {
  const fx = makeRepo();
  const s = 'Use a flag, e.g. foo, to run it, which is tested here.';
  const res = run(fx, {
    text: `${s}\n`,
    rows: [['C1', s, 'command', 'bun test', fx.sha]],
  });
  expect(res.code).toBe(0);
});

test('bare invocation and --help print usage and exit 2', () => {
  for (const args of [[], ['--help']]) {
    const r = spawnSync('bun', [SCRIPT, ...args], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain('Usage: advisor-claims-check');
  }
});
