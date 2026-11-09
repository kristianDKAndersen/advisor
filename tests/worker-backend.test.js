import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isHerdrMode, readRunnerBackend, resolveSocketPath, resolveHerdrBin } from '../lib/worker-backend.js';

const REPO = path.resolve(import.meta.dir, '..');
const herdrKeys = () => Object.keys(process.env).filter((k) => k === 'ADVISOR_HERDR' || k.startsWith('HERDR_'));

let saved;
let tmpDir;

beforeEach(() => {
  saved = {};
  for (const k of herdrKeys()) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-backend-'));
});

afterEach(() => {
  for (const k of herdrKeys()) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function thrownError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('isHerdrMode', () => {
  test('true only when ADVISOR_HERDR and HERDR_ENV are both exactly "1"', () => {
    expect(isHerdrMode({ ADVISOR_HERDR: '1', HERDR_ENV: '1' })).toBe(true);
  });

  test.each([
    [{}],
    [{ ADVISOR_HERDR: '1' }],
    [{ HERDR_ENV: '1' }],
    [{ ADVISOR_HERDR: '0', HERDR_ENV: '1' }],
    [{ ADVISOR_HERDR: '1', HERDR_ENV: '0' }],
    [{ ADVISOR_HERDR: 'true', HERDR_ENV: '1' }],
    [{ ADVISOR_HERDR: '1', HERDR_ENV: 'true' }],
    [{ ADVISOR_HERDR: '1', HERDR_ENV: '' }],
    [{ ADVISOR_HERDR: '1', HERDR_SOCKET_PATH: '/tmp/herdr.sock', HERDR_PANE_ID: 'p1' }],
  ])('false for %j', (env) => {
    expect(isHerdrMode(env)).toBe(false);
  });

  test('reads process.env when called without an argument', () => {
    process.env.ADVISOR_HERDR = '1';
    process.env.HERDR_ENV = '1';
    expect(isHerdrMode()).toBe(true);
    delete process.env.HERDR_ENV;
    expect(isHerdrMode()).toBe(false);
  });
});

describe('readRunnerBackend', () => {
  const writeRunner = (text) => fs.writeFileSync(path.join(tmpDir, 'runner.json'), text);

  test('"herdr" when runner.json.backend is "herdr"', () => {
    writeRunner(JSON.stringify({ pid: 1, mode: 'herdr', backend: 'herdr', pane_id: 'p1' }));
    expect(readRunnerBackend(tmpDir)).toBe('herdr');
  });

  test('"tmux" when runner.json.backend is "tmux"', () => {
    writeRunner(JSON.stringify({ pid: 1, backend: 'tmux', pane_id: '%3' }));
    expect(readRunnerBackend(tmpDir)).toBe('tmux');
  });

  test('"tmux" for a tmux-era runner.json without a backend key', () => {
    writeRunner(JSON.stringify({ pid: 1, pane_id: '%3' }));
    expect(readRunnerBackend(tmpDir)).toBe('tmux');
  });

  test.each([
    ['no runner.json', null],
    ['empty file', ''],
    ['malformed JSON', '{"backend":'],
    ['JSON null', 'null'],
    ['JSON array', '["herdr"]'],
    ['JSON string', '"herdr"'],
    ['wrong case', JSON.stringify({ backend: 'Herdr' })],
    ['padded value', JSON.stringify({ backend: ' herdr' })],
  ])('"tmux" for %s', (_label, text) => {
    if (text !== null) writeRunner(text);
    expect(readRunnerBackend(tmpDir)).toBe('tmux');
  });

  test('"tmux" when runner.json is unreadable as a file, without throwing', () => {
    fs.mkdirSync(path.join(tmpDir, 'runner.json'));
    expect(readRunnerBackend(tmpDir)).toBe('tmux');
  });

  test('"tmux" for a missing run dir and for a non-string run dir, without throwing', () => {
    expect(readRunnerBackend(path.join(tmpDir, 'missing'))).toBe('tmux');
    expect(readRunnerBackend(undefined)).toBe('tmux');
  });
});

describe('resolveSocketPath', () => {
  test('returns HERDR_SOCKET_PATH verbatim', () => {
    expect(resolveSocketPath({ HERDR_SOCKET_PATH: '/run/herdr/test.sock' })).toBe('/run/herdr/test.sock');
  });

  test.each([
    ['unset', {}],
    ['empty', { HERDR_SOCKET_PATH: '' }],
    ['only other herdr vars set', { HOME: '/Users/x', HERDR_PANE_ID: 'p1' }],
  ])('throws Error code HERDR_NO_SOCKET when %s (no default path is guessed)', (_label, env) => {
    const err = thrownError(() => resolveSocketPath(env));
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('HERDR_NO_SOCKET');
  });

  test('reads process.env when called without an argument', () => {
    process.env.HERDR_SOCKET_PATH = '/tmp/from-process-env.sock';
    expect(resolveSocketPath()).toBe('/tmp/from-process-env.sock');
  });
});

describe('resolveHerdrBin', () => {
  test('returns HERDR_BIN_PATH when non-empty', () => {
    expect(resolveHerdrBin({ HERDR_BIN_PATH: '/opt/herdr/bin/herdr' })).toBe('/opt/herdr/bin/herdr');
  });

  test.each([
    ['unset', {}],
    ['empty', { HERDR_BIN_PATH: '' }],
  ])('returns "herdr" (PATH lookup) when HERDR_BIN_PATH is %s', (_label, env) => {
    expect(resolveHerdrBin(env)).toBe('herdr');
  });

  test('reads process.env when called without an argument', () => {
    expect(resolveHerdrBin()).toBe('herdr');
    process.env.HERDR_BIN_PATH = '/opt/x/herdr';
    expect(resolveHerdrBin()).toBe('/opt/x/herdr');
  });
});

describe('herdr binary is spawned only through resolveHerdrBin', () => {
  // Catches a literal 'herdr' as the first argument of a spawn/exec call.
  // A binary name held in a variable is not detectable here.
  const SPAWN_LITERAL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`]herdr['"`]/;
  const libDir = path.join(REPO, 'lib');

  test('pattern control: catches literal spawns and ignores resolveHerdrBin calls', () => {
    expect(SPAWN_LITERAL.test("spawnSync('herdr', ['ping'])")).toBe(true);
    expect(SPAWN_LITERAL.test('execFile(\n  "herdr",')).toBe(true);
    expect(SPAWN_LITERAL.test('spawnSync(resolveHerdrBin(env), [])')).toBe(false);
  });

  test('no existing lib/herdr-*.js file spawns a literal herdr binary', () => {
    const herdrFiles = fs.readdirSync(libDir).filter((f) => /^herdr-.*\.js$/.test(f));
    const offenders = herdrFiles.filter((f) => SPAWN_LITERAL.test(fs.readFileSync(path.join(libDir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
