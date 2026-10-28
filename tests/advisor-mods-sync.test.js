import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'advisor-mods-sync');

let tmp, repoRoot, installDir, stub, stubLog;

function put(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-mods-sync-test-'));
  repoRoot = path.join(tmp, 'repo');
  installDir = path.join(tmp, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  put(repoRoot, 'mods/alpha/hooks.js', 'v2\n');
  put(repoRoot, 'mods/alpha/sub/new.js', 'new\n');
  put(repoRoot, 'mods/beta/hooks.js', 'beta\n');
  stub = path.join(tmp, 'claude-stub.sh');
  stubLog = path.join(tmp, 'stub.log');
  fs.writeFileSync(
    stub,
    '#!/bin/sh\necho "$@" >> "$STUB_LOG"\nif [ "$2" = "test" ] && [ -n "$STUB_FAIL_TEST" ]; then echo stub-test-failure; exit 1; fi\nif [ "$2" = "validate" ] && [ -n "$STUB_FAIL_VALIDATE" ]; then echo stub-validate-failure; exit 1; fi\nexit 0\n',
    { mode: 0o755 }
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args = [], env = {}) {
  return spawnSync(BIN, ['--install-dir', installDir, '--repo-root', repoRoot, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ADVISOR_MODS_SYNC_CLAUDE: stub, STUB_LOG: stubLog, ...env },
  });
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) {
        out[rel + '/'] = 'dir';
        walk(p);
      } else {
        out[rel] = fs.readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

const read = (rel) => fs.readFileSync(path.join(installDir, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(installDir, rel));
const backups = () => fs.readdirSync(installDir).filter((n) => n.startsWith('.alpha.bak-'));

function installStale() {
  put(installDir, 'alpha/hooks.js', 'v1\n');
  put(installDir, 'alpha/gone.js', 'deleted in repo\n');
  put(installDir, 'alpha/.claude-plugin/types/gen.d.ts', 'generated\n');
}

function installInSync() {
  put(installDir, 'alpha/hooks.js', 'v2\n');
  put(installDir, 'alpha/sub/new.js', 'new\n');
}

test('T1: --check on an in-sync mod prints IN-SYNC and exits 0', () => {
  installInSync();
  const r = run(['alpha', '--check']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('IN-SYNC');
});

test('T2: --check ignores types/ and .sync.json', () => {
  installInSync();
  put(installDir, 'alpha/.claude-plugin/types/gen.d.ts', 'x');
  put(installDir, 'alpha/.sync.json', '{}');
  expect(run(['alpha', '--check']).status).toBe(0);
});

test('T3: --check on drift lists changed/added/removed and exits 1', () => {
  installStale();
  const r = run(['alpha', '--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('DRIFT');
  expect(r.stdout).toContain('hooks.js');
  expect(r.stdout).toContain(path.join('sub', 'new.js'));
  expect(r.stdout).toContain('gone.js');
  expect(r.stdout).not.toContain('gen.d.ts');
});

test('T4: --check on a mod absent from the install dir prints NOT-INSTALLED and exits 1', () => {
  const r = run(['beta', '--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('NOT-INSTALLED');
});

test('T5: --check and --dry-run write nothing', () => {
  installStale();
  const before = snapshot(tmp);
  expect(run(['alpha', '--check']).status).toBe(1);
  const dry = run(['alpha', '--dry-run']);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain('plugin validate');
  expect(dry.stdout).toContain('.alpha.bak-');
  expect(dry.stdout).toContain('gone.js');
  expect(snapshot(tmp)).toEqual(before);
  expect(fs.existsSync(stubLog)).toBe(false);
});

test('T6: sync mirrors repo, preserves types/, stamps .sync.json, backs up, runs validate+test', () => {
  installStale();
  const r = run(['alpha']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('IN-SYNC');
  expect(r.stdout).toMatch(/restart Claude Code/i);
  expect(read('alpha/hooks.js')).toBe('v2\n');
  expect(read('alpha/sub/new.js')).toBe('new\n');
  expect(exists('alpha/gone.js')).toBe(false);
  expect(read('alpha/.claude-plugin/types/gen.d.ts')).toBe('generated\n');
  const stamp = JSON.parse(read('alpha/.sync.json'));
  expect(stamp.repo).toBe(repoRoot);
  expect(Object.keys(stamp)).toEqual(expect.arrayContaining(['repo', 'branch', 'commit', 'dirty', 'syncedAt']));
  const bak = backups();
  expect(bak.length).toBe(1);
  expect(fs.readFileSync(path.join(installDir, bak[0], 'hooks.js'), 'utf8')).toBe('v1\n');
  expect(fs.readFileSync(path.join(installDir, bak[0], 'gone.js'), 'utf8')).toBe('deleted in repo\n');
  const log = fs.readFileSync(stubLog, 'utf8');
  expect(log).toContain('plugin validate --strict ' + path.join(repoRoot, 'mods', 'alpha'));
  expect(log).toContain('plugin test ' + path.join(repoRoot, 'mods', 'alpha'));
  expect(fs.readdirSync(installDir).filter((n) => n.includes('.stage-') || n.includes('.old-'))).toEqual([]);
  expect(run(['alpha', '--check']).status).toBe(0);
});

test('T7: failing claude plugin test refuses the mod and leaves install byte-identical', () => {
  installStale();
  const before = snapshot(installDir);
  const r = run(['alpha'], { STUB_FAIL_TEST: '1' });
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/refus/i);
  expect(snapshot(installDir)).toEqual(before);
});

test('T8: --skip-tests does not call claude', () => {
  installStale();
  expect(run(['alpha', '--skip-tests'], { STUB_FAIL_TEST: '1' }).status).toBe(0);
  expect(fs.existsSync(stubLog)).toBe(false);
  expect(read('alpha/hooks.js')).toBe('v2\n');
});

test('T9: invalid mod names exit 2 and write nothing', () => {
  installStale();
  const before = snapshot(tmp);
  for (const bad of ['../evil', 'Alpha', '-x', 'a/b', '.hidden']) {
    const r = run([bad]);
    expect(r.status).toBe(2);
  }
  expect(snapshot(tmp)).toEqual(before);
});

test('T10: valid name with no repo mod exits 2 with a message', () => {
  const r = run(['nonesuch']);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('nonesuch');
});

test('T11: default discovery covers installed mods that exist in the repo, skipping others', () => {
  installStale();
  put(installDir, 'orphan/hooks.js', 'not in repo');
  const r = run(['--check', '--json']);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  expect(rows.map((x) => x.mod)).toEqual(['alpha']);
  expect(rows[0].status).toBe('DRIFT');
  expect(r.status).toBe(1);
});

test('T12: sync of a not-installed mod installs it without a backup', () => {
  const r = run(['beta', '--skip-tests']);
  expect(r.status).toBe(0);
  expect(fs.readFileSync(path.join(installDir, 'beta', 'hooks.js'), 'utf8')).toBe('beta\n');
  expect(fs.readdirSync(installDir).filter((n) => n.includes('.bak-'))).toEqual([]);
});

test('T13: sync on an in-sync mod changes nothing', () => {
  installInSync();
  const before = snapshot(installDir);
  const r = run(['alpha']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('IN-SYNC');
  expect(snapshot(installDir)).toEqual(before);
});

test('T14: --help exits 0 and unknown flag exits 2', () => {
  const h = run(['--help']);
  expect(h.status).toBe(0);
  expect(h.stdout).toContain('Usage');
  expect(run(['--bogus']).status).toBe(2);
});

test('T15: failing claude plugin validate refuses the mod, install untouched, plugin test never runs', () => {
  installStale();
  const before = snapshot(installDir);
  const r = run(['alpha'], { STUB_FAIL_VALIDATE: '1' });
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/REFUSED/);
  expect(snapshot(installDir)).toEqual(before);
  const log = fs.readFileSync(stubLog, 'utf8');
  expect(log).toContain('plugin validate');
  expect(log).not.toContain('plugin test');
});

test('T16: multi-mod run with one refused mod still syncs the other and exits 1', () => {
  installStale();
  put(installDir, 'beta/hooks.js', 'old beta\n');
  put(repoRoot, 'mods/beta/hooks.js', 'beta v2\n');
  const stubBad = path.join(tmp, 'claude-stub-alpha.sh');
  fs.writeFileSync(stubBad, '#!/bin/sh\ncase "$*" in *mods/alpha*) echo alpha-bad; exit 1;; esac\nexit 0\n', { mode: 0o755 });
  const alphaBefore = snapshot(path.join(installDir, 'alpha'));
  const r = run(['alpha', 'beta'], { ADVISOR_MODS_SYNC_CLAUDE: stubBad });
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/alpha: REFUSED/);
  expect(snapshot(path.join(installDir, 'alpha'))).toEqual(alphaBefore);
  expect(read('beta/hooks.js')).toBe('beta v2\n');
});

test('T17: --json on a real sync reports synced:true, an existing backup and IN-SYNC', () => {
  installStale();
  const r = run(['alpha', '--json']);
  expect(r.status).toBe(0);
  const row = JSON.parse(r.stdout.trim());
  expect(row.synced).toBe(true);
  expect(row.status).toBe('IN-SYNC');
  expect(fs.existsSync(row.backup)).toBe(true);
});

test('T18: --dry-run on a not-installed mod says no backup and writes nothing', () => {
  const before = snapshot(tmp);
  const r = run(['beta', '--dry-run']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('no existing install, no backup');
  expect(snapshot(tmp)).toEqual(before);
});

test('T19: uncommitted changes warn and stamp dirty:true with the commit SHA; clean tree stamps dirty:false', () => {
  const g = (...a) => spawnSync('git', ['-C', repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const sha = g('rev-parse', 'HEAD').stdout.trim();
  installStale();
  const clean = run(['alpha']);
  expect(clean.status).toBe(0);
  expect(clean.stdout).not.toMatch(/uncommitted/);
  expect(JSON.parse(read('alpha/.sync.json')).dirty).toBe(false);
  put(repoRoot, 'mods/alpha/hooks.js', 'dirty\n');
  const dirty = run(['alpha']);
  expect(dirty.status).toBe(0);
  expect(dirty.stdout).toMatch(/uncommitted changes/);
  const stamp = JSON.parse(read('alpha/.sync.json'));
  expect(stamp.dirty).toBe(true);
  expect(stamp.commit).toBe(sha);
});

test('T20: symlinks in a repo mod are mirrored verbatim and drift sees a changed link target', () => {
  fs.symlinkSync('hooks.js', path.join(repoRoot, 'mods/alpha/link'));
  expect(run(['alpha', '--skip-tests']).status).toBe(0);
  const link = path.join(installDir, 'alpha', 'link');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(link)).toBe('hooks.js');
  fs.unlinkSync(link);
  fs.symlinkSync('sub/new.js', link);
  const r = run(['alpha', '--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('DRIFT');
  expect(r.stdout).toContain('link');
});

test('T21: a pre-existing .old-<pid> dir does not break the swap or leave new debris', () => {
  installStale();
  const stale = path.join(installDir, '.alpha.old-$$');
  const script = `mkdir -p "${stale}" && echo keep > "${stale}/f" && exec "$@"`;
  const r = spawnSync('sh', ['-c', script, 'sh', BIN, '--install-dir', installDir, '--repo-root', repoRoot, 'alpha', '--skip-tests'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(read('alpha/hooks.js')).toBe('v2\n');
  const olds = fs.readdirSync(installDir).filter((n) => n.includes('.old-'));
  expect(olds.length).toBe(1);
  expect(fs.readFileSync(path.join(installDir, olds[0], 'f'), 'utf8')).toBe('keep\n');
  expect(fs.readdirSync(installDir).filter((n) => n.includes('.stage-'))).toEqual([]);
});

test('T22: a failure while staging exits 1, leaves install byte-identical, and leaves no .stage-/.old-/.bak- debris', () => {
  installStale();
  put(repoRoot, 'mods/alpha/.claude-plugin', 'a file where the types parent dir must go\n');
  const before = snapshot(installDir);
  const r = run(['alpha', '--skip-tests']);
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/FAILED/);
  expect(snapshot(installDir)).toEqual(before);
  expect(fs.readdirSync(installDir).filter((n) => /\.(stage|old|bak)-/.test(n))).toEqual([]);
});

test('T23: both swap renames failing keeps the backup and the .old copy, and the output names both', () => {
  installStale();
  const fault = path.join(tmp, 'fault.cjs');
  const target = path.join(installDir, 'alpha');
  fs.writeFileSync(
    fault,
    `const fs = require('fs'); const r = fs.renameSync;\nfs.renameSync = (a, b) => { if (b === ${JSON.stringify(target)}) throw new Error('injected rename failure'); return r(a, b); };\n`
  );
  const r = run(['alpha', '--skip-tests', '--json'], { NODE_OPTIONS: `--require ${fault}` });
  expect(r.status).toBe(1);
  const row = JSON.parse(r.stdout.trim().split('\n')[0]);
  expect(row.status).toBe('FAILED');
  const bak = backups();
  expect(bak.length).toBe(1);
  expect(fs.readFileSync(path.join(installDir, bak[0], 'hooks.js'), 'utf8')).toBe('v1\n');
  const olds = fs.readdirSync(installDir).filter((n) => n.startsWith('.alpha.old-'));
  expect(olds.length).toBe(1);
  expect(fs.readFileSync(path.join(installDir, olds[0], 'hooks.js'), 'utf8')).toBe('v1\n');
  expect(row.recoverFrom).toBe(path.join(installDir, olds[0]));
  expect(row.backup).toBe(path.join(installDir, bak[0]));
  expect(r.stdout).toContain(row.recoverFrom);
  expect(fs.readdirSync(installDir).filter((n) => n.includes('.stage-'))).toEqual([]);
  expect(row.reason).toContain(row.recoverFrom);
  expect(row.reason).toContain(row.backup);
});

function withUnreadable(file, fn) {
  fs.chmodSync(file, 0o000);
  try {
    fn();
  } finally {
    fs.chmodSync(file, 0o644);
  }
}

const asRoot = process.getuid && process.getuid() === 0;

test.skipIf(asRoot)('T24: an unreadable repo file gives that mod a FAILED row, no stack trace, other mods still processed (--check, --dry-run, sync, --json)', () => {
  installInSync();
  put(installDir, 'beta/hooks.js', 'beta\n');
  withUnreadable(path.join(repoRoot, 'mods/alpha/hooks.js'), () => {
    for (const mode of [['--check'], ['--dry-run'], ['--skip-tests']]) {
      const r = run(mode);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/alpha: FAILED - .*hooks\.js/);
      expect(r.stdout).toContain('beta: IN-SYNC');
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
    const j = run(['--check', '--json']);
    const rows = j.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((x) => x.mod === 'alpha').status).toBe('FAILED');
    expect(rows.find((x) => x.mod === 'alpha').reason).toContain('hooks.js');
    expect(rows.find((x) => x.mod === 'beta').status).toBe('IN-SYNC');
  });
});

test.skipIf(asRoot)('T25: an unreadable install file gives FAILED, and a sync leaves no debris', () => {
  installInSync();
  withUnreadable(path.join(installDir, 'alpha/hooks.js'), () => {
    const r = run(['alpha', '--skip-tests']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/alpha: FAILED - .*hooks\.js/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(fs.readdirSync(installDir).filter((n) => /\.(stage|old|bak)-/.test(n))).toEqual([]);
  });
});

test('T26: a claude call that outlives ADVISOR_MODS_SYNC_TIMEOUT_MS is killed, the mod is REFUSED as timed out, install byte-identical', () => {
  installStale();
  const before = snapshot(installDir);
  const hang = path.join(tmp, 'claude-stub-hang.sh');
  fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 });
  const r = run(['alpha'], { ADVISOR_MODS_SYNC_CLAUDE: hang, ADVISOR_MODS_SYNC_TIMEOUT_MS: '300' });
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/REFUSED - claude plugin validate timed out/);
  expect(snapshot(installDir)).toEqual(before);
});
