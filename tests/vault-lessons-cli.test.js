// Tests for `advisor-vault lessons ...` and the search flag pass-through.
// Every spawn runs against temp ADVISOR_VAULT / ADVISOR_RUNS_ROOT dirs and a temp doctrine file.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BIN = path.resolve(import.meta.dir, '../bin/advisor-vault');
const ANCHOR = 'Always run the tests first';

let root, vault, runs, doctrine;

function put(rel, fm, body) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(abs, `---\n${head}\n---\n\n${body}`);
}

function lesson(rel, { status, audience, heuristic = 'Check the thing first.', extra = 'alpha beta' }) {
  const fm = { type: 'lesson', sid: 's1', created_at: new Date().toISOString(), task_type: extra, status };
  if (audience) fm.audience = audience;
  put(rel, fm, `Tags: ${extra}\n\n## Root cause\nbecause\n\n## Heuristic\n${heuristic}\n\n## Evidence\nseq 1\n`);
}

function run(args, extraEnv = {}) {
  return spawnSync('bun', [BIN, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ADVISOR_VAULT: vault, ADVISOR_RUNS_ROOT: runs, ADVISOR_DOCTRINE_FILE: doctrine, ...extraEnv },
  });
}

function snapshot() {
  const out = {};
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.startsWith('vault.db')) out[path.relative(vault, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(vault);
  return out;
}

const read = rel => fs.readFileSync(path.join(vault, rel), 'utf8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-lessons-cli-'));
  vault = path.join(root, 'vault');
  runs = path.join(root, 'runs');
  doctrine = path.join(root, 'doctrine.md');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(doctrine, `# Doctrine\n\n${ANCHOR} before writing code.\n`);
  lesson('lessons/proposed-one.md', { status: 'proposed' });
  lesson('lessons/active-adv.md', { status: 'active', audience: 'advisor' });
  lesson('lessons/active-wrk.md', { status: 'active', audience: 'worker' });
  lesson('lessons/active-both.md', { status: 'active', audience: 'both', extra: 'alpha beta zebra' });
  lesson('lessons/archive/old-retired.md', { status: 'retired', extra: 'zebra' });
  put('synthesis/syn-1.md', { type: 'synthesis', sid: 's1', created_at: new Date().toISOString(), next_action: 'spawn-refinement' },
    '## Established\nzebra crossing established\n\n## Gap\nzebra gap missing\n');
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const reindex = () => expect(run(['rebuild']).status).toBe(0);

test('bare lessons prints usage exit 1 no side effects', () => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(vault);
  const r = run(['lessons']);
  expect(r.status).toBe(1);
  expect(r.stderr.toLowerCase()).toContain('usage');
  expect(fs.readdirSync(vault)).toEqual([]);
});

test('bare mutator without --lesson prints usage exit 1', () => {
  const before = snapshot();
  for (const args of [['approve'], ['audience', '--set', 'both'], ['audience', '--lesson', 'active-adv.md'], ['promote', '--to', ANCHOR],
    ['promote', '--lesson', 'active-adv.md'], ['retire'], ['keep']]) {
    const r = run(['lessons', ...args]);
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('usage');
  }
  expect(snapshot()).toEqual(before);
});

test('unknown flag exits 2 without acting', () => {
  const before = snapshot();
  for (const args of [['approve', 'proposed-one.md', '--audience', 'both', '--bogus'], ['retire', '--lesson', 'active-adv.md', '--dry-runn'],
    ['keep', '--lesson', 'active-adv.md', '--force'], ['capture', '--nope'], ['list', '--bogus'], ['review', '--bogus']]) {
    const r = run(['lessons', ...args]);
    expect(r.status).toBe(2);
  }
  expect(snapshot()).toEqual(before);
});

for (const sub of ['list', 'review', 'stats', 'recall', 'approve', 'audience', 'promote', 'retire', 'keep', 'capture']) {
  test(`[HELP] lessons ${sub} --help exits 0 no side effects`, () => {
    const before = snapshot();
    for (const flag of ['--help', '-h']) {
      const r = run(['lessons', sub, flag]);
      expect(r.status).toBe(0);
      expect(r.stdout.toLowerCase()).toContain('usage');
    }
    expect(snapshot()).toEqual(before);
  });
}

const MUTATORS = {
  approve: ['approve', '--lesson', 'proposed-one.md', '--audience', 'both'],
  audience: ['audience', '--lesson', 'active-adv.md', '--set', 'worker'],
  promote: ['promote', '--lesson', 'active-adv.md', '--to', ANCHOR],
  retire: ['retire', '--lesson', 'active-adv.md', '--reason', 'obsolete'],
  keep: ['keep', '--lesson', 'active-adv.md'],
  capture: ['capture', '--source', 'return'],
};

for (const [name, args] of Object.entries(MUTATORS)) {
  test(`dry-run ${name} leaves files byte-identical`, () => {
    const before = snapshot();
    const r = run(['lessons', ...args, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^changed:/m);
    expect(snapshot()).toEqual(before);
  });
}

test('approve --audience sets audience and status active', () => {
  const r = run(['lessons', 'approve', '--lesson', 'proposed-one.md', '--audience', 'worker']);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^changed:/m);
  const text = read('lessons/proposed-one.md');
  expect(text).toContain('status: active');
  expect(text).toContain('audience: worker');
});

test('approve accepts positional ref', () => {
  const r = run(['lessons', 'approve', 'proposed-one.md', '--audience', 'both']);
  expect(r.status).toBe(0);
  expect(read('lessons/proposed-one.md')).toContain('status: active');
  const before = snapshot();
  for (const args of [['approve', 'proposed-one.md', '--lesson', 'proposed-one.md'], ['approve', 'a.md', 'b.md'], ['keep', 'a.md', 'b.md']]) {
    const bad = run(['lessons', ...args]);
    expect(bad.status).toBe(1);
    expect(bad.stderr.toLowerCase()).toContain('usage');
  }
  expect(snapshot()).toEqual(before);
});

test('recall --audience advisor returns only advisor/both lessons', () => {
  reindex();
  const r = run(['lessons', 'recall', '--text', 'alpha beta gamma delta', '--audience', 'advisor', '--json']);
  expect(r.status).toBe(0);
  const paths = JSON.parse(r.stdout).map(l => l.path);
  expect(paths).toContain('lessons/active-adv.md');
  expect(paths).toContain('lessons/active-both.md');
  expect(paths).not.toContain('lessons/active-wrk.md');
  expect(paths).not.toContain('lessons/proposed-one.md');
});

test('capture writes only proposed lessons', () => {
  const before = snapshot();
  expect(run(['lessons', 'review']).stdout).toContain('last_capture_ts: never');
  const r = run(['lessons', 'capture', '--source', 'return']);
  expect(r.status).toBe(0);
  const after = snapshot();
  const added = Object.keys(after).filter(k => !(k in before));
  const lessons = added.filter(k => k.startsWith('lessons/'));
  expect(lessons.length).toBe(1);
  for (const k of lessons) expect(read(k)).toContain('status: proposed');
  expect(added.filter(k => !k.startsWith('lessons/')).sort()).toEqual(['.cache/capture-state.json', '.cache/lessons.jsonl']);
  for (const k of Object.keys(before)) expect(after[k]).toBe(before[k]);
  const state = JSON.parse(read('.cache/capture-state.json'));
  expect(typeof state.last_capture_ts).toBe('number');
  expect(run(['lessons', 'review']).stdout).toContain(`last_capture_ts: ${state.last_capture_ts}`);
});

test('search --include-inactive shows retired', () => {
  reindex();
  expect(run(['search', '--text', 'zebra']).stdout).not.toContain('old-retired');
  const r = run(['search', '--text', 'zebra', '--include-inactive']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('lessons/archive/old-retired.md');
  expect(r.stdout).toContain('status=retired');
});

test('search --type lesson restricts results', () => {
  reindex();
  expect(run(['search', '--text', 'zebra']).stdout).toContain('[synthesis]');
  const r = run(['search', '--text', 'zebra', '--type', 'lesson']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[lesson]');
  expect(r.stdout).not.toContain('[synthesis]');
});

test('search prints status marker', () => {
  reindex();
  const r = run(['search', '--text', 'zebra', '--type', 'lesson']);
  expect(r.stdout).toMatch(/active-both\.md.*status=active/);
});

const VALUE_FLAGS = [
  ['--lesson', ['keep'], '--dry-run'], ['--audience', ['approve', 'proposed-one.md'], '--dry-run'], ['--set', ['audience', 'active-adv.md'], '--dry-run'],
  ['--to', ['promote', 'active-adv.md'], '--dry-run'], ['--reason', ['retire', 'active-adv.md'], '--dry-run'], ['--status', ['list'], '--json'],
  ['--text', ['recall'], '--json'], ['--limit', ['recall', '--text', 'zebra'], '--json'], ['--source', ['capture'], '--dry-run'],
  ['--since-days', ['capture'], '--dry-run'],
];

test('retire --reason --dry-run exits 1 and leaves files byte-identical', () => {
  const before = snapshot();
  const r = run(['lessons', 'retire', '--lesson', 'active-adv.md', '--reason', '--dry-run']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('--reason requires a value');
  expect(snapshot()).toEqual(before);
});

for (const [flag, pre, next] of VALUE_FLAGS) {
  test(`${flag} followed by ${next} is treated as missing value`, () => {
    const before = snapshot();
    const r = run(['lessons', ...pre, flag, next]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${flag} requires a value`);
    expect(r.stderr.toLowerCase()).toContain('usage');
    expect(snapshot()).toEqual(before);
  });
}

test('--reason=value form works, including values starting with --', () => {
  const r = run(['lessons', 'retire', '--lesson', 'active-adv.md', '--reason=--weird reason', '--dry-run']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('retired_reason=--weird reason');
});
