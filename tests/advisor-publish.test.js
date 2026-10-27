const { test, expect, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'bin', 'advisor-publish');
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const ORIGIN_URL = 'https://github.com/o/r.git';
const scratch = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd, ...args) {
  const r = spawnSync(REAL_GIT, ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, name, content) {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function commitAll(repo, msg) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

// Throwaway repo: main has README.md, branch feat adds prFiles. origin's URL is
// github.com/o/r; the PATH shims log every gh write and turn `git push` into a push
// to the bare temp origin (or a failure with SHIM_PUSH_FAIL=1). Read-only gh calls
// (auth status, pr view) go to reads.log; pr view reports HEAD unless SHIM_PR_* say otherwise.
function makeFixture({ prFiles = { 'src/a.js': 'a\n' }, origin = ORIGIN_URL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-publish-'));
  scratch.push(dir);
  const bare = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', bare);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'README.md', 'one\ntwo\n');
  const base = commitAll(repo, 'base');
  git(repo, 'checkout', '-q', '-b', 'feat');
  for (const [p, c] of Object.entries(prFiles)) write(repo, p, c);
  const head = commitAll(repo, 'pr');
  git(repo, 'remote', 'add', 'origin', origin);
  const shim = join(dir, 'shim');
  const log = join(dir, 'shim.log');
  const reads = join(dir, 'reads.log');
  write(
    shim,
    'gh',
    `#!/bin/sh\nif [ "$1" = auth ]; then\n  echo "gh $*" >> "${reads}"\n  [ "$*" = "auth status --hostname \${SHIM_AUTH_HOST:-github.com}" ]; exit $?\nfi\n` +
      `if [ "$1 $2" = "pr view" ]; then\n  echo "gh $* | GH_HOST=$GH_HOST" >> "${reads}"\n` +
      `  printf '{"headRefOid":"%s","headRefName":"%s","headRepository":{"name":"r"},"headRepositoryOwner":{"login":"%s"}}\\n' "\${SHIM_PR_HEAD:-$(git rev-parse HEAD)}" "\${SHIM_PR_BRANCH:-feat}" "\${SHIM_PR_OWNER:-o}"\n  exit 0\nfi\n` +
      `echo "gh $* | GH_REPO=$GH_REPO | GH_HOST=$GH_HOST | cwd=$(pwd)" >> "${log}"\n[ -n "$SHIM_GH_FAIL" ] && exit 1\nexit 0\n`,
  );
  write(
    shim,
    'git',
    `#!/bin/sh\nif [ "$1" = push ]; then\n  echo "git $* | cwd=$(pwd)" >> "${log}"\n  [ -n "$SHIM_PUSH_FAIL" ] && { echo "push rejected" >&2; exit 1; }\n  eval last=\\\${$#}\n  exec "${REAL_GIT}" push -q "${bare}" "$last"\nfi\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shim, 'gh'), 0o755);
  chmodSync(join(shim, 'git'), 0o755);
  return { dir, repo, bare, base, head, log, reads, runs: join(dir, 'runs') };
}

function review(fx, { scope = 'full-pr', base = fx.base, head = fx.head, verdict = 'APPROVE', open = 0, blockers = [], raw } = {}) {
  const body =
    raw ??
    `---\naudit_scope: ${scope}\naudit_base_sha: ${base}\naudit_head_sha: ${head}\nverdict: ${verdict}\nopen_blockers: ${open}\n---\n` +
      `## Code Review: x\n\n### Blockers (must fix)\n${blockers.map((b) => `- **[${b}]** \`a:1\` - t\n`).join('')}\n### Warnings (should fix)\n- **[W1]** \`a:1\` - w\n`;
  return write(fx.dir, 'review.md', body);
}

function run(fx, args, { cwd = fx.dir, env = {} } = {}) {
  const r = spawnSync('bun', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      PATH: `${join(fx.dir, 'shim')}:${process.env.PATH}`,
      ADV: ROOT,
      ADVISOR_RUNS_ROOT: fx.runs,
      ADVISOR_VAULT: join(fx.dir, 'vault'),
      ...env,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

const base = (fx, rv = review(fx)) => ['--repo', fx.repo, '--target', 'main', '--review', rv];
const shimLog = (fx) => (existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '');
const passingClaims = (fx) => write(fx.dir, 'claims.md', '| id | sentence | evidence_type | evidence | sha |\n|----|----|----|----|----|\n');

test('bare invocation prints usage and exits 2; no action exits 2', () => {
  const r = spawnSync('bun', [SCRIPT], { encoding: 'utf8' });
  expect(r.status).toBe(2);
  expect(r.stdout + r.stderr).toContain('Usage: advisor-publish');
  const fx = makeFixture();
  expect(run(fx, base(fx)).code).toBe(2);
});

test('T1 audit at HEAD and merge-base, APPROVE, 0 Blockers: exit 0, dry run prints the push', () => {
  const fx = makeFixture();
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(`git push origin ${fx.head}:refs/heads/feat`);
  expect(shimLog(fx)).toBe('');
});

test('T2 a commit after the audit: exit 3', () => {
  const fx = makeFixture();
  const rv = review(fx);
  write(fx.repo, 'src/b.js', 'b\n');
  const h2 = commitAll(fx.repo, 'after audit');
  const res = run(fx, [...base(fx, rv), '--push', 'origin', 'feat']);
  expect(res.code).toBe(3);
  expect(res.out).toContain('STALE_AUDIT');
  expect(res.out).toContain(fx.head);
  expect(res.out).toContain(h2);
  // Text actions are audit-bound too: nothing runs.
  const text = write(fx.dir, 'text.md', 'Thanks for the review.\n');
  const textOnly = run(fx, [...base(fx, rv), '--pr', '7', '--comment', text, '--reply', `99=${text}`, '--claims', passingClaims(fx)]);
  expect(textOnly.code).toBe(3);
  expect(shimLog(fx)).toBe('');
});

test('T3 clean merge of the target with an unchanged PR patch: exit 0 (patch-id reuse)', () => {
  const fx = makeFixture();
  const rv = review(fx);
  git(fx.repo, 'checkout', '-q', 'main');
  write(fx.repo, 'other.txt', 'x\n');
  commitAll(fx.repo, 'main moves');
  git(fx.repo, 'checkout', '-q', 'feat');
  git(fx.repo, 'merge', '-q', '--no-edit', 'main');
  expect(run(fx, [...base(fx, rv), '--push', 'origin', 'feat']).code).toBe(0);
});

test('T4 a merge whose conflict resolution changes the PR diff: exit 3', () => {
  const fx = makeFixture({ prFiles: { 'README.md': 'one\nPR\n' } });
  const rv = review(fx);
  git(fx.repo, 'checkout', '-q', 'main');
  write(fx.repo, 'README.md', 'one\nMAIN\n');
  commitAll(fx.repo, 'main conflicts');
  git(fx.repo, 'checkout', '-q', 'feat');
  spawnSync(REAL_GIT, ['merge', '-q', '--no-edit', 'main'], { cwd: fx.repo, env: GIT_ENV });
  write(fx.repo, 'README.md', 'one\nRESOLVED\n');
  commitAll(fx.repo, 'resolve');
  const res = run(fx, [...base(fx, rv), '--push', 'origin', 'feat']);
  expect(res.code).toBe(3);
  expect(res.out).toContain('STALE_AUDIT');
});

test('T5 audit_scope delta exits 3; missing frontmatter exits 3', () => {
  const fx = makeFixture();
  expect(run(fx, [...base(fx, review(fx, { scope: 'delta' })), '--push', 'origin', 'feat']).code).toBe(3);
  expect(run(fx, [...base(fx, review(fx, { raw: '## Code Review: x\n' })), '--push', 'origin', 'feat']).code).toBe(3);
});

test('audit_scope: uncommitted exits 3', () => {
  const fx = makeFixture();
  expect(run(fx, [...base(fx, review(fx, { scope: 'uncommitted' })), '--push', 'origin', 'feat']).code).toBe(3);
});

test('T6 verdict IN PROGRESS (skeleton review): exit 4', () => {
  const fx = makeFixture();
  expect(run(fx, [...base(fx, review(fx, { verdict: 'IN PROGRESS' })), '--push', 'origin', 'feat']).code).toBe(4);
});

test('T7 open_blockers 0 with one [B1] entry in the body: exit 4', () => {
  const fx = makeFixture();
  const res = run(fx, [...base(fx, review(fx, { blockers: ['B1'] })), '--push', 'origin', 'feat']);
  expect(res.code).toBe(4);
  expect(res.out).toContain('BLOCKERS');
});

test('T8 --body without --claims exits 5; a failing claims check exits 5', () => {
  const fx = makeFixture();
  const body = write(fx.dir, 'body.md', 'Fixed the guard; all 12 tests pass.\n');
  expect(run(fx, [...base(fx), '--pr', '7', '--body', body]).code).toBe(5);
  const res = run(fx, [...base(fx), '--pr', '7', '--body', body, '--claims', passingClaims(fx)]);
  expect(res.code).toBe(5);
  expect(res.out).toContain('UNCOVERED_SENTENCE');
  expect(run(fx, [...base(fx), '--pr', '7', '--comment', body, '--claims', passingClaims(fx)]).code).toBe(5);
  expect(run(fx, [...base(fx), '--pr', '7', '--reply', `99=${body}`, '--claims', passingClaims(fx)]).code).toBe(5);
  expect(shimLog(fx)).toBe('');
});

test('T9 PR adds .advisor-output/x: exit 6; PR adds a // eco: line: exit 6', () => {
  const a = makeFixture({ prFiles: { '.advisor-output/x': 'x\n' } });
  expect(run(a, [...base(a), '--push', 'origin', 'feat']).code).toBe(6);
  const b = makeFixture({ prFiles: { 'src/a.js': 'const a = 1;\n// eco: x\n' } });
  const res = run(b, [...base(b), '--push', 'origin', 'feat']);
  expect(res.code).toBe(6);
  expect(res.out).toContain('src/a.js:2');
});

test('T10 CONTRIBUTING.md without a decision exits 7; with a decisions line exit 0; digest policy_paths apply', () => {
  const fx = makeFixture({ prFiles: { 'CONTRIBUTING.md': '- be nice\n', 'docs/policy.md': 'p\n' } });
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(7);
  expect(res.out).toContain('CONTRIBUTING.md');
  const decisions = write(fx.dir, 'decisions.md', 'CONTRIBUTING.md: "yes, ship the CONTRIBUTING change"\n');
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat', '--decisions', decisions]).code).toBe(0);
  // The digest's policy_paths (vault note frontmatter) replace the defaults.
  const slug = `repo-${createHash('sha1').update(ORIGIN_URL).digest('hex').slice(0, 8)}`;
  write(join(fx.dir, 'vault'), `repo-rules/${slug}.md`, '---\npolicy_paths: [docs/*.md]\n---\nnote\n');
  const viaDigest = run(fx, [...base(fx), '--push', 'origin', 'feat', '--decisions', decisions]);
  expect(viaDigest.code).toBe(7);
  expect(viaDigest.out).toContain('docs/policy.md');
});

test('T11 --repo is the advisor repo: exit 0 not applicable, nothing runs', () => {
  const fx = makeFixture();
  const res = run(fx, ['--repo', ROOT, '--target', 'master', '--review', review(fx), '--push', 'origin', 'x', '--pr', '1', '--comment', review(fx)]);
  expect(res.code).toBe(0);
  expect(res.out).toContain('not applicable: advisor repo');
  expect(shimLog(fx)).toBe('');
});

test('T12 --execute with a failing push: exit 8, publish-log unchanged, later commands skipped', () => {
  const fx = makeFixture();
  const comment = write(fx.dir, 'comment.md', 'Thanks for the review.\n');
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat', '--pr', '7', '--comment', comment, '--claims', passingClaims(fx), '--execute'], {
    env: { SHIM_PUSH_FAIL: '1' },
  });
  expect(res.code).toBe(8);
  expect(res.out).toContain('git push');
  expect(existsSync(join(fx.runs, 'publish-log.jsonl'))).toBe(false);
  expect(shimLog(fx)).not.toContain('gh ');
});

test('T13 --execute succeeds: one new log line with head_sha and target', () => {
  // Run from the advisor repo's cwd: every command must still run in the target repo.
  const fx = makeFixture();
  const text = write(fx.dir, 'text.md', 'Thanks for the review.\n');
  const args = [...base(fx), '--push', 'origin', 'feat', '--pr', '7', '--body', text, '--comment', text, '--reply', `99=${text}`];
  const res = run(fx, [...args, '--claims', passingClaims(fx), '--execute'], { cwd: ROOT });
  expect(res.code).toBe(0);
  const lines = readFileSync(join(fx.runs, 'publish-log.jsonl'), 'utf8').trim().split('\n');
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0]);
  expect(entry.head_sha).toBe(fx.head);
  expect(entry.target).toBe('main');
  expect(entry.actions.length).toBe(4);
  expect(git(fx.bare, 'rev-parse', 'refs/heads/feat')).toBe(fx.head);
  const log = shimLog(fx).trim().split('\n');
  expect(log.length).toBe(4);
  expect(log[3]).toContain('api -X POST repos/o/r/pulls/7/comments/99/replies -F body=@');
  for (const l of log) expect(l).toContain(`cwd=${realpathSync(fx.repo)}`);
  for (const l of log.filter((x) => x.startsWith('gh '))) expect(l).toContain('GH_REPO=o/r');
  for (const l of log.filter((x) => x.startsWith('gh pr '))) expect(l).toContain('-R o/r');
});

test('T14 run from the advisor cwd with --repo <temp o/r>: dry run targets o/r, cwd temp repo, -R o/r on every gh', () => {
  const fx = makeFixture();
  const text = write(fx.dir, 'text.md', 'Thanks for the review.\n');
  const args = [...base(fx), '--push', 'origin', 'feat', '--pr', '7', '--body', text, '--comment', text, '--reply', `99=${text}`];
  const res = run(fx, [...args, '--claims', passingClaims(fx)], { cwd: ROOT });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('target o/r');
  expect(res.stdout).toContain(`cwd ${realpathSync(fx.repo)}`);
  const ghLines = res.stdout.split('\n').filter((l) => /\bgh /.test(l));
  expect(ghLines.length).toBe(3);
  for (const l of ghLines) expect(l).toContain('GH_REPO=o/r gh ');
  for (const l of ghLines.filter((x) => x.includes(' gh pr '))) expect(l).toContain('-R o/r');
  expect(ghLines.filter((x) => x.includes(' gh api ') && x.includes(' repos/o/r/pulls/7/')).length).toBe(1);
  expect(res.stdout).not.toContain('{owner}');
  expect(res.stdout).not.toContain('{repo}');
  expect(shimLog(fx)).toBe('');
});

const ZERO_SHA = '0'.repeat(40);
const thanks = (fx) => write(fx.dir, 'text.md', 'Thanks for the review.\n');
const frontmatterAt = (fx) => `---\naudit_scope: full-pr\naudit_base_sha: ${fx.base}\naudit_head_sha: ${fx.head}\nverdict: APPROVE\nopen_blockers: 0\n---\n`;

test('B1 an option string in audit_base_sha: exit 3 and git never runs it (no file written)', () => {
  const fx = makeFixture();
  const target = join(fx.dir, 'pwned');
  const res = run(fx, [...base(fx, review(fx, { base: `--output=${target}`, head: 'HEAD' })), '--push', 'origin', 'feat']);
  expect(res.code).toBe(3);
  expect(res.out).toContain('STALE_AUDIT');
  expect(existsSync(target)).toBe(false);
});

test('B2 a symbolic or abbreviated audit_head_sha: exit 3, even when the PR diff matches', () => {
  const fx = makeFixture();
  for (const head of ['HEAD', 'feat', fx.head.slice(0, 12)]) {
    expect(run(fx, [...base(fx, review(fx, { head })), '--push', 'origin', 'feat']).code).toBe(3);
  }
  const rv = review(fx, { head: 'feat' });
  write(fx.repo, 'src/evil.js', 'evil()\n');
  commitAll(fx.repo, 'after audit');
  expect(run(fx, [...base(fx, rv), '--push', 'origin', 'feat']).code).toBe(3);
});

test('B3 a whitespace-only change after the audit: exit 3 (patch-id --verbatim)', () => {
  const fx = makeFixture({ prFiles: { 'src/a.py': 'if guard:\n    deny()\nallow()\n' } });
  const rv = review(fx);
  write(fx.repo, 'src/a.py', 'if guard:\n    deny()\n    allow()\n');
  commitAll(fx.repo, 'reindent');
  expect(run(fx, [...base(fx, rv), '--push', 'origin', 'feat']).code).toBe(3);
});

test('B4 the remote host is pinned (GH_HOST, gh api --hostname); a nested path or unauthenticated host exits 2', () => {
  const fx = makeFixture({ origin: 'git@ghe.example.com:team/svc.git' });
  const text = thanks(fx);
  const args = [...base(fx), '--pr', '7', '--comment', text, '--reply', `99=${text}`, '--claims', passingClaims(fx)];
  const ghe = run(fx, args, { env: { SHIM_AUTH_HOST: 'ghe.example.com' } });
  expect(ghe.code).toBe(0);
  expect(ghe.stdout).toContain('target team/svc on ghe.example.com');
  const ghLines = ghe.stdout.split('\n').filter((l) => /\bgh /.test(l));
  expect(ghLines.length).toBe(2);
  for (const l of ghLines) expect(l).toContain('GH_HOST=ghe.example.com GH_REPO=team/svc gh ');
  expect(ghLines[1]).toContain('gh api -X POST repos/team/svc/pulls/7/comments/99/replies');
  expect(ghLines[1]).toMatch(/ --hostname ghe\.example\.com$/);
  expect(readFileSync(fx.reads, 'utf8')).toContain('GH_HOST=ghe.example.com');
  expect(run(fx, args).code).toBe(2);
  // A user-level GH_HOST never leaks into a github.com target.
  const gh = makeFixture();
  const leak = run(gh, [...base(gh), '--pr', '7', '--comment', thanks(gh), '--claims', passingClaims(gh)], { env: { GH_HOST: 'ghe.example.com' } });
  expect(leak.code).toBe(0);
  expect(leak.stdout).toContain('GH_HOST=github.com GH_REPO=o/r gh pr comment 7 -R o/r');
  const nested = makeFixture({ origin: 'https://gitlab.com/grp/sub/proj.git' });
  expect(run(nested, [...base(nested), '--push', 'origin', 'feat']).code).toBe(2);
  const gitlab = makeFixture({ origin: 'https://gitlab.com/grp/proj.git' });
  const res = run(gitlab, [...base(gitlab), '--push', 'origin', 'feat']);
  expect(res.code).toBe(2);
  expect(res.out).toContain('gitlab.com');
});

test('W1 --pr must be the PR whose head is the audited HEAD (or the pushed branch): exit 3, no gh write', () => {
  const fx = makeFixture();
  const args = [...base(fx), '--pr', '21', '--comment', thanks(fx), '--claims', passingClaims(fx)];
  const wrongHead = run(fx, args, { env: { SHIM_PR_HEAD: ZERO_SHA } });
  expect(wrongHead.code).toBe(3);
  expect(wrongHead.out).toContain('PR_HEAD');
  expect(run(fx, [...args, '--push', 'origin', 'feat'], { env: { SHIM_PR_BRANCH: 'other' } }).code).toBe(3);
  expect(run(fx, args).code).toBe(0);
  expect(readFileSync(fx.reads, 'utf8')).toContain('pr view 21 -R o/r --json');
  expect(shimLog(fx)).toBe('');
  // After the push the PR head must be H before any gh write.
  const res = run(fx, [...args, '--push', 'origin', 'feat', '--execute'], { env: { SHIM_PR_HEAD: ZERO_SHA } });
  expect(res.code).toBe(8);
  expect(shimLog(fx)).not.toContain('gh ');
});

test('W2 the push refspec is the audited SHA; --force-with-lease passes through, never --force', () => {
  const fx = makeFixture();
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat', '--force-with-lease']);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(`git push --force-with-lease origin ${fx.head}:refs/heads/feat`);
  expect(res.stdout).not.toMatch(/--force(?!-with-lease)/);
  expect(res.stdout).not.toContain('HEAD:');
});

test('W3 a -diff gitattribute does not hide an added eco: line: exit 6', () => {
  const fx = makeFixture({ prFiles: { '.gitattributes': '*.js -diff\n', 'src/a.js': '// eco: skip tests\n' } });
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(6);
  expect(res.out).toContain('src/a.js:1');
});

test('W4 paths git would C-quote still hit checks 6 and 7', () => {
  const a = makeFixture({ prFiles: { 'captures/a"b.png': 'x\n' } });
  expect(run(a, [...base(a), '--push', 'origin', 'feat']).code).toBe(6);
  const b = makeFixture({ prFiles: { 'guardrails/a"b.md': 'x\n' } });
  const res = run(b, [...base(b), '--push', 'origin', 'feat']);
  expect(res.code).toBe(7);
  expect(res.out).toContain('guardrails/a"b.md needs');
});

test('W5 default policy paths cover the docs/ and .github/ copies in any case', () => {
  const files = ['.github/CONTRIBUTING.md', 'docs/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE/f.md', 'docs/pull_request_template.md', 'contributing.md'];
  const fx = makeFixture({ prFiles: Object.fromEntries(files.map((f) => [f, 'x\n'])) });
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(7);
  for (const f of files) expect(res.out).toContain(`${f} needs`);
});

test('W6 an empty --policy-paths list exits 2', () => {
  const fx = makeFixture({ prFiles: { 'CONTRIBUTING.md': 'x\n' } });
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat', '--policy-paths', ',']).code).toBe(2);
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat', '--policy-paths', ' ']).code).toBe(2);
});

test('W7 Blockers recount: variant heading or list marker, or no Blockers heading, exits 4', () => {
  const fx = makeFixture();
  const bodies = [
    '## Blockers\n- **[B1]** `a:1` - real\n',
    '### BLOCKERS\n1. **[B1]** `a:1` - real\n',
    '### Blockers (must fix)\n* **[B1]** `a:1` - real\n',
    '## Code Review: x\n\n### Warnings (should fix)\n- **[W1]** w\n',
  ];
  for (const body of bodies) expect(run(fx, [...base(fx, review(fx, { raw: frontmatterAt(fx) + body })), '--push', 'origin', 'feat']).code).toBe(4);
  const fenced = '### Blockers (must fix)\nNone.\n\n```\n- **[B1]** example\n```\n';
  expect(run(fx, [...base(fx, review(fx, { raw: frontmatterAt(fx) + fenced })), '--push', 'origin', 'feat']).code).toBe(0);
});

test('W8 --execute: a gh failure after the push exits 8 and logs the push as partial; a log write failure exits 8', () => {
  const fx = makeFixture();
  const args = [...base(fx), '--push', 'origin', 'feat', '--pr', '7', '--comment', thanks(fx), '--claims', passingClaims(fx), '--execute'];
  expect(run(fx, args, { env: { SHIM_GH_FAIL: '1' } }).code).toBe(8);
  const lines = readFileSync(join(fx.runs, 'publish-log.jsonl'), 'utf8').trim().split('\n');
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0]);
  expect(entry.status).toBe('partial');
  expect(entry.actions.length).toBe(1);
  expect(entry.actions[0]).toContain('git push');
  const blocked = write(fx.dir, 'runs-file', 'x');
  const noLog = run(fx, args, { env: { ADVISOR_RUNS_ROOT: join(blocked, 'runs') } });
  expect(noLog.code).toBe(8);
  expect(noLog.out).toContain('publish-log.jsonl');
});

test('W9 --pr-remote: PR actions target the upstream repo while the push goes to the fork', () => {
  const fx = makeFixture();
  git(fx.repo, 'remote', 'add', 'fork', 'https://github.com/me/r.git');
  const args = [...base(fx), '--push', 'fork', 'feat', '--pr', '12', '--comment', thanks(fx), '--claims', passingClaims(fx), '--pr-remote', 'origin'];
  const res = run(fx, args, { env: { SHIM_PR_OWNER: 'me' } });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(`git push fork ${fx.head}:refs/heads/feat`);
  expect(res.stdout).toContain('GH_REPO=o/r gh pr comment 12 -R o/r');
  expect(readFileSync(fx.reads, 'utf8')).toContain('pr view 12 -R o/r');
  // PR #12's head must be the fork's branch.
  expect(run(fx, args).code).toBe(3);
});

test('W10 a failing advisor-conventions exits 7 instead of falling back to the defaults', () => {
  const fx = makeFixture();
  const bunShim = join(fx.dir, 'bunshim');
  write(bunShim, 'bun', `#!/bin/sh\ncase "$1" in */advisor-conventions) exit \${SHIM_CONV_EXIT:-1};; esac\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(bunShim, 'bun'), 0o755);
  const PATH = `${bunShim}:${join(fx.dir, 'shim')}:${process.env.PATH}`;
  const crash = run(fx, [...base(fx), '--push', 'origin', 'feat'], { env: { PATH } });
  expect(crash.code).toBe(7);
  expect(crash.out).toContain('advisor-conventions');
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat'], { env: { PATH, SHIM_CONV_EXIT: '0' } }).code).toBe(7);
});

test('W11 --json output shape; ADV unset falls back to the script repo', () => {
  const fx = makeFixture();
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat', '--json']);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out).toMatchObject({ exit: 0, rule: null, status: 'dry-run', target: 'o/r', host: 'github.com', head_sha: fx.head, base_sha: fx.base });
  expect(out.commands).toEqual([`git push origin ${fx.head}:refs/heads/feat`]);
  const adv = run(fx, ['--repo', ROOT, '--target', 'master', '--review', review(fx), '--push', 'origin', 'x'], { env: { ADV: '' } });
  expect(adv.code).toBe(0);
  expect(adv.out).toContain('not applicable: advisor repo');
});

test('W12 an added line starting with "++ " is scanned for eco: markers: exit 6', () => {
  const fx = makeFixture({ prFiles: { 'b.txt': '++ eco: skip\n' } });
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(6);
  expect(res.out).toContain('b.txt:1');
});

test('W13 credentials in the remote URL are never printed', () => {
  const fx = makeFixture({ origin: 'https://u:SECRET@github.com/o/r.git' });
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(0);
  expect(res.out).not.toContain('SECRET');
  expect(res.stdout).toContain('https://github.com/o/r.git');
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat', '--json']).out).not.toContain('SECRET');
});
