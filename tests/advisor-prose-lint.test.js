const { test, expect, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-prose-lint');
const CONVENTIONS = join(__dirname, '..', 'bin', 'advisor-conventions');
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

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

// Throwaway repo with a base commit (`base` files), a digest built by the real
// advisor-conventions from a vault repo-rules note holding `rules` as frontmatter
// (no note when `rules` is null), then a second commit with the `change` files.
function makeFixture({ rules = null, base = {}, change = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'prose-lint-'));
  scratch.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  write(repo, 'CONTRIBUTING.md', '- Be kind.\n');
  for (const [rel, content] of Object.entries(base)) write(repo, rel, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, ADVISOR_VAULT: join(dir, 'vault') };
  const out = join(dir, 'out');
  const conventions = () => spawnSync('bun', [CONVENTIONS, '--repo', repo, '--out', out, '--json'], { encoding: 'utf8', env });
  const slug = JSON.parse(conventions().stdout).slug;
  if (rules) write(env.ADVISOR_VAULT, `repo-rules/${slug}.md`, `---\n${rules}\n---\nbody\n`);
  expect(conventions().status).toBe(0);
  if (Object.keys(change).length > 0) {
    for (const [rel, content] of Object.entries(change)) write(repo, rel, content);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'change');
  }
  return { dir, repo, env, baseSha, digest: join(out, 'conventions-digest.md') };
}

function lint(fx, args, digest = fx.digest) {
  const r = spawnSync('bun', [SCRIPT, '--digest', digest, ...args], { encoding: 'utf8', env: fx.env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split('\n').filter(Boolean) };
}

const diffArgs = (fx) => ['--repo', fx.repo, '--base', fx.baseSha];

test('a 33-word sentence with max_sentence_words: 25 exits 1', () => {
  const fx = makeFixture({ rules: 'max_sentence_words: 25', change: { 'docs/note.md': `${words(33)}.\n\n${words(25)}.\n` } });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(1);
  expect(res.lines[0]).toMatch(/^docs\/note\.md:1 max_sentence_words /);
  const json = JSON.parse(lint(fx, [...diffArgs(fx), '--json']).stdout);
  expect(json.exit_code).toBe(1);
  expect(json.findings).toHaveLength(1);
});

test('a two-sentence comment with max_comment_sentences: 1 exits 1', () => {
  const fx = makeFixture({
    rules: 'max_comment_sentences: 1',
    change: { 'src/a.js': 'const a = 1; // One. Two.\n// Fine.\nconst b = 2;\n', 'src/b.py': '# First line.\n# Second line.\nx = 1\n' },
  });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(2);
  expect(res.lines[0]).toMatch(/^src\/a\.js:1 max_comment_sentences /);
  expect(res.lines[1]).toMatch(/^src\/b\.py:1 max_comment_sentences /);
});

test('a banned review-ID phrase in a comment exits 1', () => {
  const fx = makeFixture({ rules: 'banned_phrases:\n  - "PR 17 review"', change: { 'x.sh': '# PR 17 review 5628164865: K1\necho "PR 17 review"\n' } });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(1);
  expect(res.lines[0]).toMatch(/^x\.sh:1 banned_phrases /);
});

test('a 168-char added line with max_line_length: 120 exits 1 even under file_max_lines', () => {
  const long = `const x = '${'a'.repeat(168 - 13)}';`;
  expect(long).toHaveLength(168);
  const fx = makeFixture({ rules: 'max_line_length: 120\nfile_max_lines: 600', change: { 'src/long.js': `${long}\n` } });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(1);
  expect(res.lines[0]).toMatch(/^src\/long\.js:1 max_line_length /);
});

test('a 42-word sentence in a brief file in text mode exits 1', () => {
  const fx = makeFixture({ rules: 'max_sentence_words: 25' });
  const brief = write(fx.dir, 'brief.md', `Intro.\n\n${words(42)}.\n`);
  const res = lint(fx, ['--text', brief]);
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(1);
  expect(res.lines[0]).toBe(`${brief}:3 max_sentence_words sentence has 42 words, limit 25`);
});

test('a pre-existing long line that the diff does not touch exits 0', () => {
  const long = `const x = '${'a'.repeat(155)}';`;
  const fx = makeFixture({
    rules: 'max_sentence_words: 25\nmax_line_length: 120',
    base: { 'src/long.js': `${long}\n\n// ${words(40)}.\n` },
    change: { 'src/long.js': `${long}\n\n// ${words(40)}.\n\nconst y = 1;\n` },
  });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(0);
  expect(res.stdout).not.toContain('max_');
});

test('code fences in markdown are skipped', () => {
  const rules = 'max_sentence_words: 25\nbanned_phrases:\n  - leverage';
  const body = `Short intro.\n\n\`\`\`\n${words(40)}.\nWe leverage this.\n\`\`\`\n`;
  const fx = makeFixture({ rules, change: { 'docs/fence.md': body } });
  expect(lint(fx, diffArgs(fx)).code).toBe(0);
  expect(lint(fx, ['--text', join(fx.repo, 'docs/fence.md')]).code).toBe(0);
  const bare = write(fx.dir, 'unfenced.md', `Short intro.\n\n${words(40)}.\n\nWe leverage this.\n`);
  const res = lint(fx, ['--text', bare]);
  expect(res.code).toBe(1);
  expect(res.lines.map((l) => l.split(' ')[1]).sort()).toEqual(['banned_phrases', 'max_sentence_words']);
});

test('a digest without the measurable block exits 3', () => {
  const change = { 'src/a.js': `// ${words(60)}.\n` };
  const none = makeFixture({ change });
  expect(readNone(none.digest)).toBe(true);
  expect(lint(none, diffArgs(none)).code).toBe(3);
  const missing = write(none.dir, 'no-section.md', '## Rule sources\n\nRule files: none found\n');
  expect(lint(none, diffArgs(none), missing).code).toBe(3);
  const unrelated = makeFixture({ rules: 'policy_paths:\n  - docs/policy/', change });
  expect(lint(unrelated, diffArgs(unrelated)).code).toBe(3);
});

function readNone(path) {
  return require('node:fs').readFileSync(path, 'utf8').includes('## Measurable rules\n\nnone:');
}

test('a bare invocation prints usage and exits 2', () => {
  const r = spawnSync('bun', [SCRIPT], { encoding: 'utf8' });
  expect(r.status).toBe(2);
  expect(r.stdout + r.stderr).toContain('Usage: advisor-prose-lint');
  expect(spawnSync('bun', [SCRIPT, '--help'], { encoding: 'utf8' }).status).toBe(2);
});

test('max_comment_words caps the words of a whole comment block', () => {
  const fx = makeFixture({
    rules: 'max_comment_words: 10',
    change: { 'src/a.ts': `// ${words(11)}\nconst a = 1;\n// ${words(10)}\nconst b = 2;\n/* ${words(5)}\n * ${words(6)} */\n` },
  });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(2);
  expect(res.lines[0]).toMatch(/^src\/a\.ts:1 max_comment_words /);
  expect(res.lines[1]).toMatch(/^src\/a\.ts:5 max_comment_words /);
});

test('banned_chars flags a character in a comment and in markdown prose', () => {
  const fx = makeFixture({
    rules: 'banned_chars: ["—", "§"]',
    change: { 'src/a.py': '# one — two\nlabel = "—"\n', 'docs/a.md': 'See § 4 for details.\n' },
  });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(2);
  expect(res.lines[0]).toMatch(/^docs\/a\.md:1 banned_chars /);
  expect(res.lines[1]).toMatch(/^src\/a\.py:1 banned_chars /);
});

test('file_max_lines flags a touched file over the cap and spares one at the cap', () => {
  const lines = (n) => `${Array.from({ length: n }, (_, i) => `line${i}`).join('\n')}\n`;
  const fx = makeFixture({
    rules: 'file_max_lines: 5',
    base: { 'untouched.txt': lines(9) },
    change: { 'over.txt': lines(8), 'at.txt': lines(5) },
  });
  const res = lint(fx, diffArgs(fx));
  expect(res.code).toBe(1);
  expect(res.lines).toHaveLength(1);
  expect(res.lines[0]).toMatch(/^over\.txt:1 file_max_lines /);
});
