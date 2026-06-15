import { test, expect, describe } from 'bun:test';
import { execFileSync, execSync } from 'child_process';
import { existsSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const captureBin = new URL('../bin/capture', import.meta.url).pathname;

describe('bin/capture', () => {
  test('filters noisy output and writes raw log', () => {
    const capturesDir = join(tmpdir(), `capture-test-${Date.now()}`);
    mkdirSync(capturesDir, { recursive: true });
    // Generate noisy output (>2048 bytes)
    const cmd = `node -e "for(let i=0;i<200;i++) console.log('building module ' + i + '...');"`;
    let out = '';
    try {
      out = execSync(`node ${captureBin} node -e "for(let i=0;i<200;i++) console.log('building module ' + i + '...');"`, {
        encoding: 'utf8',
        env: { ...process.env, OUTPUT_DIR: join(capturesDir, '..') },
      });
    } catch (e) { out = e.stdout || ''; }
    // Raw log written
    const logDir = join(capturesDir, '..', 'captures');
    const logs = existsSync(logDir) ? readdirSync(logDir).filter(f => f.endsWith('.log')) : [];
    expect(logs.length).toBeGreaterThan(0);
    rmSync(capturesDir, { recursive: true, force: true });
  });

  test('preserves non-zero exit code from failing command', () => {
    const capturesDir = join(tmpdir(), `capture-fail-${Date.now()}`);
    mkdirSync(capturesDir, { recursive: true });
    let exitCode = 0;
    try {
      execFileSync('node', [captureBin, 'node', '-e', 'process.exit(42)'], {
        encoding: 'utf8',
        env: { ...process.env, OUTPUT_DIR: capturesDir },
      });
    } catch (e) { exitCode = e.status; }
    expect(exitCode).toBe(42);
    rmSync(capturesDir, { recursive: true, force: true });
  });

  test('prints footer with output-filter stats for large output', () => {
    const capturesDir = join(tmpdir(), `capture-footer-${Date.now()}`);
    mkdirSync(capturesDir, { recursive: true });
    let out = '';
    try {
      out = execSync(`node ${captureBin} node -e "for(let i=0;i<300;i++) process.stdout.write('noise line ' + i + '\\n');"`, {
        encoding: 'utf8',
        env: { ...process.env, OUTPUT_DIR: capturesDir },
      });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    expect(out).toMatch(/\[output-filter: \d+->\d+ lines; raw at /);
    rmSync(capturesDir, { recursive: true, force: true });
  });
});
