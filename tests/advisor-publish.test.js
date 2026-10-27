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

// Throwaway repo: main has baseFiles and is pushed to the bare temp origin, branch feat adds
// prFiles. origin's URL is github.com/o/r; the PATH shims log every gh write and turn `git push`
// into a push to the bare origin (or a failure with SHIM_PUSH_FAIL=1) and `git ls-remote` into a
// read of it (or SHIM_LS_OID). Read-only calls go to reads.log; pr view reports HEAD, base main and
// state OPEN unless SHIM_PR_* say otherwise (SHIM_PR_HEADS: the head for each pr view call in turn).
function makeFixture({ prFiles = { 'src/a.js': 'a\n' }, origin = ORIGIN_URL, baseFiles = { 'README.md': 'one\ntwo\n' }, objectFormat = 'sha1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-publish-'));
  scratch.push(dir);
  const bare = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', `--object-format=${objectFormat}`, bare);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`);
  for (const [p, c] of Object.entries(baseFiles)) write(repo, p, c);
  const base = commitAll(repo, 'base');
  git(repo, 'push', '-q', bare, 'main');
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
      `if [ "$1 $2" = "pr view" ]; then\n  echo "gh $* | GH_HOST=$GH_HOST" >> "${reads}"\n  head=\${SHIM_PR_HEAD:-$(git rev-parse HEAD)}\n` +
      `  if [ -n "$SHIM_PR_HEADS" ]; then\n    n=$(grep -c '^gh pr view' "${reads}")\n    set -- $SHIM_PR_HEADS\n    while [ "$n" -gt 1 ] && [ $# -gt 1 ]; do shift; n=$((n - 1)); done\n    head=$1\n  fi\n` +
      `  printf '{"headRefOid":"%s","headRefName":"%s","headRepository":{"name":"r"},"headRepositoryOwner":{"login":"%s"},"baseRefName":"%s","baseRefOid":"%s","state":"%s"}\\n' "$head" "\${SHIM_PR_BRANCH:-feat}" "\${SHIM_PR_OWNER:-o}" "\${SHIM_PR_BASE_NAME:-main}" "\${SHIM_PR_BASE_OID:-$(git rev-parse main)}" "\${SHIM_PR_STATE:-OPEN}"\n  exit 0\nfi\n` +
      `if [ "$1" = api ] && [ "$2" != -X ]; then\n  echo "gh $* | GH_HOST=$GH_HOST | GH_REPO=$GH_REPO" >> "${reads}"\n  [ -n "$SHIM_PERM_FAIL" ] && exit 1\n` +
      `  if [ "$2" = user ]; then echo "\${SHIM_LOGIN:-me}"; else echo "\${SHIM_PERM_PUSH:-true}"; fi\n  exit 0\nfi\n` +
      `echo "gh $* | GH_REPO=$GH_REPO | GH_HOST=$GH_HOST | cwd=$(pwd)" >> "${log}"\n[ -n "$SHIM_GH_FAIL" ] && exit 1\nexit 0\n`,
  );
  write(
    shim,
    'git',
    `#!/bin/sh\nif [ "$1" = push ]; then\n  echo "git $* | cwd=$(pwd)" >> "${log}"\n  [ -n "$SHIM_PUSH_FAIL" ] && { echo "push rejected" >&2; exit 1; }\n  eval last=\\\${$#}\n  exec "${REAL_GIT}" push -q "${bare}" "$last"\nfi\n` +
      `if [ "$1" = ls-remote ]; then\n  echo "git $*" >> "${reads}"\n  shift 2\n` +
      `  if [ -n "$SHIM_LS_OID" ]; then for r in "$@"; do printf '%s\\t%s\\n' "$SHIM_LS_OID" "$r"; done; exit 0; fi\n` +
      `  exec "${REAL_GIT}" ls-remote "${bare}" "$@"\nfi\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(join(shim, 'gh'), 0o755);
  chmodSync(join(shim, 'git'), 0o755);
  write(shim, 'ssh', '#!/bin/sh\neval last=\\${$#}\necho "hostname $last"\n');
  chmodSync(join(shim, 'ssh'), 0o755);
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
  git(fx.repo, 'push', '-q', fx.bare, 'main');
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
  // The digest's policy_paths (vault note frontmatter) add to the defaults.
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
  // GitHub hosts only: a two-segment GitLab remote exits 2 even for a push alone.
  const gitlab = makeFixture({ origin: 'https://gitlab.com/grp/proj.git' });
  const res = run(gitlab, [...base(gitlab), '--push', 'origin', 'feat']);
  expect(res.code).toBe(2);
  expect(res.out).toContain('GitHub hosts only (policy); gitlab.com is not one');
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
}, 30000);

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

const prText = (fx) => ['--pr', '7', '--comment', thanks(fx), '--claims', passingClaims(fx)];
const prReads = (fx) => (existsSync(fx.reads) ? readFileSync(fx.reads, 'utf8') : '').split('\n').filter((l) => l.startsWith('gh pr view')).length;

test('R2-B1 (round-1 W1 base) the audited range is bound to the PR base or the push remote: narrowed or empty ranges exit 3', () => {
  const fx = makeFixture();
  write(fx.repo, 'src/b.js', 'b\n');
  const h2 = commitAll(fx.repo, 'second');
  const narrowed = () => ['--repo', fx.repo, '--target', fx.head, '--review', review(fx, { base: fx.head, head: h2 }), '--push', 'origin', 'feat'];
  const codes = { narrowed: run(fx, narrowed()).code };
  codes.empty = run(fx, ['--repo', fx.repo, '--target', 'HEAD', '--review', review(fx, { base: h2, head: h2 }), '--push', 'origin', 'feat']).code;
  // The branch being updated is a valid base once the remote has it.
  git(fx.repo, 'push', '-q', fx.bare, `${fx.head}:refs/heads/feat`);
  codes.remoteBranch = run(fx, narrowed()).code;
  // A feature on develop gated with --target develop while PR #7's base is main.
  git(fx.repo, 'checkout', '-q', '-b', 'develop', 'main');
  write(fx.repo, 'src/dev.js', 'd\n');
  const d1 = commitAll(fx.repo, 'develop');
  git(fx.repo, 'checkout', '-q', '-b', 'feat2');
  write(fx.repo, 'src/f.js', 'f\n');
  const f1 = commitAll(fx.repo, 'feature');
  const prBase = run(fx, ['--repo', fx.repo, '--target', 'develop', '--review', review(fx, { base: d1, head: f1 }), ...prText(fx)]);
  codes.prBase = prBase.code;
  const m = makeFixture();
  const missing = run(m, [...base(m), ...prText(m)], { env: { SHIM_PR_BASE_OID: '1'.repeat(40) } });
  codes.prBaseMissing = missing.code;
  expect({ ...codes, rule: prBase.out.includes('PR_BASE'), fetchHint: missing.out.includes('git fetch origin main'), wrote: shimLog(fx) + shimLog(m) }).toEqual({
    narrowed: 3, empty: 3, remoteBranch: 0, prBase: 3, prBaseMissing: 3, rule: true, fetchHint: true, wrote: '',
  });
});

test('R2-B2 (round-1 B2) a hex-named ref (64 hex in SHA-1, 40 hex in SHA-256) or a ref named after the SHA is not an audited SHA: exit 3', () => {
  const codes = {};
  for (const [fmt, len] of [['sha1', 32], ['sha256', 20]]) {
    const fx = makeFixture({ objectFormat: fmt });
    const ref = 'ab'.repeat(len);
    git(fx.repo, 'checkout', '-q', '-b', ref);
    const rv = review(fx, { head: ref });
    write(fx.repo, 'src/evil.js', 'evil()\n');
    commitAll(fx.repo, 'after audit');
    codes[fmt] = run(fx, [...base(fx, rv), '--push', 'origin', 'feat']).code;
  }
  const fx = makeFixture();
  git(fx.repo, 'branch', fx.head);
  codes.namedAfterSha = run(fx, [...base(fx), '--push', 'origin', 'feat']).code;
  expect(codes).toEqual({ sha1: 3, sha256: 3, namedAfterSha: 3 });
});

test('R2-B3 the patch-id diff is pinned: zero-context config or env and submodule knobs cannot relocate or hide a change: exit 3', () => {
  const src = 'function del() {\n  work();\n}\nfunction list() {\n  work();\n}\n';
  const fx = makeFixture({ baseFiles: { 'h.js': src }, prFiles: { 'h.js': src.replace('del() {\n', 'del() {\n  auth();\n') } });
  const rv = review(fx);
  write(fx.repo, 'h.js', src.replace('list() {\n', 'list() {\n  auth();\n'));
  commitAll(fx.repo, 'move auth() from del to list');
  const args = [...base(fx, rv), '--push', 'origin', 'feat'];
  const codes = {
    defaults: run(fx, args).code,
    diffOpts: run(fx, args, { env: { GIT_DIFF_OPTS: '-u0' } }).code,
    configEnv: run(fx, args, { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.context', GIT_CONFIG_VALUE_0: '0' } }).code,
  };
  git(fx.repo, 'config', 'diff.context', '0');
  codes.repoConfig = run(fx, args).code;
  // A gitlink bump after the audit, hidden by diff.ignoreSubmodules or reformatted by diff.submodule.
  const sub = makeFixture();
  git(sub.repo, 'update-index', '--add', '--cacheinfo', `160000,${sub.base},sub`);
  git(sub.repo, 'commit', '-q', '-m', 'add sub');
  const subRv = review(sub, { head: git(sub.repo, 'rev-parse', 'HEAD') });
  git(sub.repo, 'update-index', '--cacheinfo', `160000,${sub.head},sub`);
  git(sub.repo, 'commit', '-q', '-m', 'bump sub');
  const subArgs = [...base(sub, subRv), '--push', 'origin', 'feat'];
  git(sub.repo, 'config', 'diff.ignoreSubmodules', 'all');
  codes.ignoreSubmodules = run(sub, subArgs).code;
  git(sub.repo, 'config', '--unset', 'diff.ignoreSubmodules');
  git(sub.repo, 'config', 'diff.submodule', 'log');
  codes.submoduleLog = run(sub, subArgs).code;
  expect(codes).toEqual({ defaults: 3, diffOpts: 3, configEnv: 3, repoConfig: 3, ignoreSubmodules: 3, submoduleLog: 3 });
});

test('R2-W1 (round-1 W7) Blockers recount: any [B<n>] token outside CommonMark fences counts; an unclosed fence exits 4', () => {
  const fx = makeFixture();
  const bodies = {
    plus: '### Blockers (must fix)\n+ **[B1]** `a:1` - real\n',
    paren: '### Blockers (must fix)\n1) **[B1]** `a:1` - real\n',
    bare: '### Blockers (must fix)\n[B1] `a:1` - real\n',
    tildeInBacktick: '### Blockers (must fix)\n```\n~~~\n```\n- **[B1]** `a:1` - real\n',
    nestedFence: '### Blockers (must fix)\nQuoting the README:\n````md\n```js\nx()\n```\n````\n- **[B1]** `a:1` - real\n',
    indented: '### Blockers (must fix)\nNone.\n\n    ```\n- **[B1]** `a:1` - real\n    ```\n',
    unclosed: '### Blockers (must fix)\nNone.\n\n```\n- **[B1]** example\n',
    fencedExample: '### Blockers (must fix)\nNone.\n\n~~~~\n- **[B1]** example\n~~~\n~~~~\n',
  };
  const codes = Object.fromEntries(Object.entries(bodies).map(([k, b]) => [k, run(fx, [...base(fx, review(fx, { raw: frontmatterAt(fx) + b })), '--push', 'origin', 'feat']).code]));
  expect(codes).toEqual({ plus: 4, paren: 4, bare: 4, tildeInBacktick: 4, nestedFence: 4, indented: 4, unclosed: 4, fencedExample: 0 });
});

test('R2-W2 neither ADV nor GIT_DIR/GIT_WORK_TREE makes the target repo "not applicable": a post-audit commit exits 3', () => {
  const fx = makeFixture();
  const rv = review(fx);
  write(fx.repo, 'src/evil.js', 'evil()\n');
  commitAll(fx.repo, 'after audit');
  const args = [...base(fx, rv), '--push', 'origin', 'feat'];
  const adv = run(fx, args, { env: { ADV: fx.repo } });
  const gitDir = run(fx, args, { env: { GIT_DIR: git(ROOT, 'rev-parse', '--absolute-git-dir'), GIT_WORK_TREE: ROOT } });
  expect({ adv: adv.code, gitDir: gitDir.code, notApplicable: `${adv.out}${gitDir.out}`.includes('not applicable') }).toEqual({ adv: 3, gitDir: 3, notApplicable: false });
});

test('R2-W3 (round-1 W6) --policy-paths and digest policy_paths add to the defaults: CODEOWNERS still exits 7', () => {
  const fx = makeFixture({ prFiles: { CODEOWNERS: '* @me\n' } });
  const args = [...base(fx), '--push', 'origin', 'feat'];
  const codes = { override: run(fx, [...args, '--policy-paths', 'nomatch/**']).code };
  const slug = `repo-${createHash('sha1').update(ORIGIN_URL).digest('hex').slice(0, 8)}`;
  write(join(fx.dir, 'vault'), `repo-rules/${slug}.md`, '---\npolicy_paths: [docs/*.md]\n---\nnote\n');
  codes.digest = run(fx, args).code;
  expect(codes).toEqual({ override: 7, digest: 7 });
});

test('R2-W4 (round-1 W8) --json failures carry status and executed; a missing --claims file exits 2', () => {
  const fx = makeFixture();
  const args = [...base(fx), '--push', 'origin', 'feat', ...prText(fx), '--execute', '--json'];
  const shape = (r) => {
    const o = JSON.parse(r.stdout);
    return { exit: o.exit, status: o.status, executed: (o.executed || []).length };
  };
  const got = {
    pushFailed: shape(run(fx, args, { env: { SHIM_PUSH_FAIL: '1' } })),
    partial: shape(run(fx, args, { env: { SHIM_GH_FAIL: '1' } })),
    unlogged: shape(run(fx, args, { env: { ADVISOR_RUNS_ROOT: join(write(fx.dir, 'runs-file', 'x'), 'runs') } })),
    missingClaims: run(fx, [...base(fx), '--push', 'origin', 'feat', '--claims', join(fx.dir, 'nope.md'), '--execute']).code,
  };
  expect(got).toEqual({
    pushFailed: { exit: 8, status: 'failed', executed: 0 },
    partial: { exit: 8, status: 'partial', executed: 1 },
    unlogged: { exit: 8, status: 'executed-unlogged', executed: 2 },
    missingClaims: 2,
  });
});

test('R2-W5 GitHub hosts only: a GitLab push alone exits 2 and a GitHub push alone runs gh auth; a malformed host exits 2', () => {
  const gl = makeFixture({ origin: 'https://gitlab.com/grp/proj.git' });
  const res = run(gl, [...base(gl), '--push', 'origin', 'feat']);
  const gh = makeFixture();
  run(gh, [...base(gh), '--push', 'origin', 'feat']);
  const bad = makeFixture({ origin: 'ssh://-oProxyCommand=x/o/r.git' });
  expect({
    gitlab: res.code,
    ghCalls: (existsSync(gh.reads) ? readFileSync(gh.reads, 'utf8') : '').includes('gh '),
    badHost: run(bad, [...base(bad), '--push', 'origin', 'feat']).code,
  }).toEqual({ gitlab: 2, ghCalls: true, badHost: 2 });
});

// The default ssh shim answers `ssh -G <host>` with hostname <host>; a test overrides it with writeSsh.
function writeSsh(fx, body) {
  write(join(fx.dir, 'shim'), 'ssh', `#!/bin/sh\n${body}\n`);
  chmodSync(join(fx.dir, 'shim', 'ssh'), 0o755);
}

test('CB7e github-personal alias resolves to github.com and is pinned', () => {
  const fx = makeFixture({ origin: 'git@github-personal:o/r.git' });
  writeSsh(fx, 'if [ "$1" = -G ] && [ "$2" = github-personal ]; then printf "user git\\nhostname github.com\\nport 22\\n"; exit 0; fi\nexit 255');
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat', '--pr', '7', '--comment', thanks(fx), '--claims', passingClaims(fx)]);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('target o/r on github.com');
  expect(res.stdout).toContain('GH_HOST=github.com GH_REPO=o/r gh pr comment 7 -R o/r');
  const reads = readFileSync(fx.reads, 'utf8');
  expect(reads).toContain('gh auth status --hostname github.com');
  expect(reads).not.toContain('github-personal');
  expect(res.stdout).not.toMatch(/GH_HOST=github-personal/);
});

test('CB7e ssh -G failure exits 2 naming the alias', () => {
  const fx = makeFixture({ origin: 'git@github-personal:o/r.git' });
  writeSsh(fx, 'echo "ssh: Could not resolve" >&2\nexit 255');
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat']);
  expect(res.code).toBe(2);
  expect(res.out).toContain('github-personal');
  expect(res.out).toContain('ssh -G');
});

test('CB7e push-only runs gh auth status for the resolved host', () => {
  const fx = makeFixture();
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat']).code).toBe(0);
  expect(readFileSync(fx.reads, 'utf8')).toContain('gh auth status --hostname github.com');
  const other = run(fx, [...base(fx), '--push', 'origin', 'feat'], { env: { SHIM_AUTH_HOST: 'ghe.example.com' } });
  expect(other.code).toBe(2);
  expect(other.out).toContain('advisor-publish: GitHub hosts only (policy); github.com is not one');
});

test('CB7e a host-looking alias name (github.com-private) resolves with ssh -G and is pinned', () => {
  const fx = makeFixture({ origin: 'git@github.com-private:o/r.git' });
  writeSsh(fx, 'if [ "$1" = -G ] && [ "$2" = github.com-private ]; then printf "hostname github.com\\n"; exit 0; fi\nexit 255');
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat', ...prText(fx)]);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('target o/r on github.com');
  expect(res.stdout).not.toContain('GH_HOST=github.com-private');
});

const PERM_CALL = 'gh api repos/o/r --hostname github.com --jq .permissions.push | GH_HOST=github.com | GH_REPO=o/r';
const readsLog = (fx) => (existsSync(fx.reads) ? readFileSync(fx.reads, 'utf8') : '');

test('CB7f push permission true: the dry run and --execute check it read-only with the pinned host, then proceed', () => {
  const fx = makeFixture();
  const args = [...base(fx), '--push', 'origin', 'feat', ...prText(fx)];
  const dry = run(fx, args);
  expect({ code: dry.code, checked: readsLog(fx).includes(PERM_CALL), wrote: shimLog(fx) }).toEqual({ code: 0, checked: true, wrote: '' });
  const exec = run(fx, [...args, '--execute']);
  expect({ code: exec.code, wrote: shimLog(fx).includes('gh pr comment 7') }).toEqual({ code: 0, wrote: true });
});

test('CB7f push permission false: exit 2 with the switch hint naming the login, in the dry run and under --execute, nothing runs', () => {
  const fx = makeFixture();
  const hint = 'advisor-publish: gh account work-me cannot write to o/r on github.com; switch with: gh auth switch --hostname github.com';
  const env = { SHIM_PERM_PUSH: 'false', SHIM_LOGIN: 'work-me' };
  const args = [...base(fx), '--push', 'origin', 'feat', '--pr', '7', '--body', thanks(fx), '--comment', thanks(fx), '--reply', `99=${thanks(fx)}`, '--claims', passingClaims(fx)];
  const dry = run(fx, args, { env });
  const exec = run(fx, [...args, '--execute'], { env });
  expect({ dry: dry.code, exec: exec.code, dryHint: dry.out.includes(hint), execHint: exec.out.includes(hint), ran: shimLog(fx), pushed: git(fx.bare, 'branch', '--list', 'feat') }).toEqual({
    dry: 2, exec: 2, dryHint: true, execHint: true, ran: '', pushed: '',
  });
});

test('CB7f a permissions API failure exits 2 (fail closed) with login unknown', () => {
  const fx = makeFixture();
  const res = run(fx, [...base(fx), '--pr', '7', '--comment', thanks(fx), '--claims', passingClaims(fx), '--execute'], { env: { SHIM_PERM_FAIL: '1' } });
  expect({ code: res.code, hint: res.out.includes('advisor-publish: gh account unknown cannot write to o/r on github.com; switch with: gh auth switch --hostname github.com'), ran: shimLog(fx) }).toEqual({ code: 2, hint: true, ran: '' });
});

test('CB7f push-only never calls the permissions endpoint', () => {
  const fx = makeFixture();
  expect(run(fx, [...base(fx), '--push', 'origin', 'feat'], { env: { SHIM_PERM_PUSH: 'false', SHIM_PERM_FAIL: '1' } }).code).toBe(0);
  expect(readsLog(fx)).not.toContain('gh api');
});

test('R2-W6 every push URL is validated: a second URL or push URL, or a fetch URL naming another repo, exits 2', () => {
  const twoUrls = makeFixture();
  git(twoUrls.repo, 'remote', 'set-url', '--add', 'origin', 'https://evil.example.com/x/y.git');
  const twoPush = makeFixture();
  git(twoPush.repo, 'config', '--add', 'remote.origin.pushurl', ORIGIN_URL);
  git(twoPush.repo, 'config', '--add', 'remote.origin.pushurl', 'https://evil.example.com/x/y.git');
  const split = makeFixture();
  git(split.repo, 'remote', 'set-url', '--push', 'origin', 'https://github.com/other/r.git');
  const code = (fx) => run(fx, [...base(fx), '--push', 'origin', 'feat']).code;
  expect({ twoUrls: code(twoUrls), twoPush: code(twoPush), fetchDiffers: code(split) }).toEqual({ twoUrls: 2, twoPush: 2, fetchDiffers: 2 });
});

test('R2-W7 (round-1 W13) credentials stay hidden when the URL does not parse: exit 2 without the secret', () => {
  const outs = ['https://u:SECRET@github.com:99999/o/r.git', 'https://u:SECRET@github.com/o%zz/r.git'].map((origin) => {
    const fx = makeFixture({ origin });
    const r = run(fx, [...base(fx), '--push', 'origin', 'feat']);
    return { code: r.code, leaked: r.out.includes('SECRET') };
  });
  expect(outs).toEqual([{ code: 2, leaked: false }, { code: 2, leaked: false }]);
});

test('R2-W8 --execute: the PR head moving from the old head to HEAD after the push lets the gh write run', () => {
  const fx = makeFixture();
  const res = run(fx, [...base(fx), '--push', 'origin', 'feat', ...prText(fx), '--execute'], { env: { SHIM_PR_HEADS: `${fx.base} ${fx.base} ${fx.head}` } });
  expect({ code: res.code, wrote: shimLog(fx).includes('gh pr comment 7'), prReads: prReads(fx) }).toEqual({ code: 0, wrote: true, prReads: 3 });
}, 30000);

test('R2-W9 header claims hold: tree SHAs are not commit SHAs (exit 3)', () => {
  const fx = makeFixture();
  const rv = review(fx, { base: git(fx.repo, 'rev-parse', `${fx.base}^{tree}`), head: git(fx.repo, 'rev-parse', `${fx.head}^{tree}`) });
  expect(run(fx, [...base(fx, rv), '--push', 'origin', 'feat']).code).toBe(3);
});

test('R2-POLL after the push ls-remote must show HEAD, then up to 5 PR reads wait out the old head; any other head or state stops', () => {
  const scenario = (env) => {
    const fx = makeFixture();
    const res = run(fx, [...base(fx), '--push', 'origin', 'feat', ...prText(fx), '--execute'], { env: env(fx) });
    const logPath = join(fx.runs, 'publish-log.jsonl');
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).status) : [];
    return { code: res.code, wrote: shimLog(fx).includes('gh pr comment'), prReads: prReads(fx), log };
  };
  const heads = (fx, n, last) => ({ SHIM_PR_HEADS: [...Array(n).fill(fx.base), last].join(' ') });
  expect({
    k2: scenario((fx) => heads(fx, 3, fx.head)),
    k5: scenario((fx) => heads(fx, 6, fx.base)),
    otherHead: scenario((fx) => heads(fx, 2, ZERO_SHA)),
    lsRemote: scenario(() => ({ SHIM_LS_OID: ZERO_SHA })),
    closed: scenario(() => ({ SHIM_PR_STATE: 'CLOSED' })),
  }).toEqual({
    k2: { code: 0, wrote: true, prReads: 4, log: ['executed'] },
    k5: { code: 8, wrote: false, prReads: 6, log: ['partial'] },
    otherHead: { code: 8, wrote: false, prReads: 3, log: ['partial'] },
    lsRemote: { code: 8, wrote: false, prReads: 1, log: ['partial'] },
    closed: { code: 8, wrote: false, prReads: 2, log: ['partial'] },
  });
}, 60000);
