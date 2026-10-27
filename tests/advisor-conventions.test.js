const { test, expect, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, chmodSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-conventions');
const scratch = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// Throwaway repo: tracked `files` ({relpath: content}) go into the first commit,
// each extra subject becomes an empty commit. Returns {dir, repo, out, vault}.
function makeRepo({ files = { 'README.md': 'hello\n' }, subjects = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'conventions-'));
  scratch.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  for (const s of subjects) git(repo, 'commit', '-q', '--allow-empty', '-m', s);
  return { dir, repo, out: join(dir, 'out'), vault: join(dir, 'vault'), home: join(dir, 'home') };
}

function run(fx, extra = [], env = {}) {
  mkdirSync(fx.home, { recursive: true });
  const r = spawnSync('bun', [SCRIPT, '--repo', fx.repo, '--out', fx.out, '--json', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fx.home, ADVISOR_VAULT: fx.vault, ...env },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  const digestPath = join(fx.out, 'conventions-digest.md');
  const digest = existsSync(digestPath) ? readFileSync(digestPath, 'utf8') : null;
  return { code: r.status, json, digest, stdout: r.stdout, stderr: r.stderr };
}

test('digest lists CONTRIBUTING.md, the PR template and a nested CLAUDE.md with path:line', () => {
  const fx = makeRepo({
    files: {
      'CONTRIBUTING.md': '# Contributing\n\n- Run the tests before you push.\n',
      '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n- [ ] Tests added\n',
      'pkg/sub/CLAUDE.md': '# Sub rules\nNever edit generated files.\n',
    },
  });
  const res = run(fx);
  expect(res.code).toBe(0);
  expect(res.digest).toContain('CONTRIBUTING.md:3');
  expect(res.digest).toContain('Run the tests before you push.');
  expect(res.digest).toContain('.github/PULL_REQUEST_TEMPLATE.md:2');
  expect(res.digest).toContain('pkg/sub/CLAUDE.md:2');
  expect(res.digest).toContain('Never edit generated files.');
  expect(res.digest).not.toContain('Rule files: none found');
});

test('an untracked CONTRIBUTING.md is ignored', () => {
  const fx = makeRepo();
  write(fx.repo, 'CONTRIBUTING.md', '- Untracked rule that must not appear.\n');
  const res = run(fx);
  expect(res.code).toBe(4);
  expect(res.digest).not.toContain('Untracked rule');
  expect(res.digest).not.toContain('CONTRIBUTING.md');
});

test('five "[MT-1] feat(x): y" subjects yield that commit pattern', () => {
  const fx = makeRepo({
    files: { 'CONTRIBUTING.md': '- Be kind.\n' },
    subjects: Array.from({ length: 5 }, () => '[MT-1] feat(x): y'),
  });
  const res = run(fx);
  expect(res.digest).toContain('Pattern: `[<ticket>] <type>(<scope>): <subject>`');
  expect(res.digest).toContain('[MT-1] feat(x): y');
  expect(res.json.commit_pattern).toBe('[<ticket>] <type>(<scope>): <subject>');
});

test('the vault repo-rules frontmatter is copied verbatim as the measurable block', () => {
  const fx = makeRepo({ files: { 'CONTRIBUTING.md': '- Be kind.\n' } });
  const slug = run(fx).json.slug;
  expect(slug).toBe(`repo-${createHash('sha1').update(realpathSync(fx.repo)).digest('hex').slice(0, 8)}`);
  const frontmatter = [
    'max_sentence_words: 25',
    'max_comment_sentences: 2',
    'max_comment_words: 40',
    'max_line_length: 100',
    'banned_chars: ["—", "§"]',
    'banned_phrases:',
    '  - "leverage"',
    '  - "in order to"',
    'file_max_lines: 600',
    'policy_paths:',
    '  - docs/policy/',
  ].join('\n');
  write(fx.vault, `repo-rules/${slug}.md`, `---\n${frontmatter}\n---\nUse STE for all prose.\n`);
  const res = run(fx);
  expect(res.code).toBe(0);
  expect(res.digest).toContain(`## Measurable rules\n\n\`\`\`yaml\n${frontmatter}\n\`\`\``);
  expect(res.digest).toContain('Use STE for all prose.');
});

test('a repo with no rule files exits 4 and the digest says "none found"', () => {
  const fx = makeRepo();
  const res = run(fx);
  expect(res.code).toBe(4);
  expect(res.digest).toContain('none found');
  expect(res.json.sources).toEqual([]);
});

test('a repo with no rule files but a vault note exits 0 and copies the frontmatter', () => {
  const fx = makeRepo();
  const slug = run(fx).json.slug;
  write(fx.vault, `repo-rules/${slug}.md`, '---\nmax_line_length: 80\n---\nKeep it short.\n');
  const res = run(fx);
  expect(res.code).toBe(0);
  expect(res.digest).toContain('Rule files: none found');
  expect(res.digest).toContain('```yaml\nmax_line_length: 80\n```');
  expect(res.digest).toContain('Keep it short.');
});

test('bare invocation prints usage, exits 2 and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conventions-bare-'));
  scratch.push(dir);
  const r = spawnSync('bun', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, ADVISOR_VAULT: join(dir, 'vault') } });
  expect(r.status).toBe(2);
  expect(`${r.stdout}${r.stderr}`).toContain('Usage: advisor-conventions');
  expect(readdirSync(dir)).toEqual([]);
});

test('--with-reviews is off by default: no gh call', () => {
  const fx = makeRepo({ files: { 'CONTRIBUTING.md': '- Be kind.\n' } });
  const shimDir = join(fx.dir, 'shim');
  const log = join(fx.dir, 'gh-calls.log');
  write(shimDir, 'gh', `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(shimDir, 'gh'), 0o755);
  const res = run(fx, [], { PATH: `${shimDir}:${process.env.PATH}` });
  expect(res.code).toBe(0);
  expect(existsSync(log)).toBe(false);
  expect(res.digest).not.toContain('Reviewer comments');
});
