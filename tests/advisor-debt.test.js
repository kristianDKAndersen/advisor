// tests/advisor-debt.test.js
// RED: fails until bin/advisor-debt exists.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCRIPT_PATH = path.resolve(import.meta.dir, '../bin/advisor-debt');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-debt-test-'));

  fs.writeFileSync(
    path.join(tmpDir, 'app.js'),
    "function f() {\n  // eco: skipped input validation; upgrade when handling untrusted input\n  return 1;\n}\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, 'script.sh'),
    "#!/bin/bash\n# eco: skipped retry logic; upgrade when flaky network observed\necho hi\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, 'page.html'),
    "<div>\n<!-- eco: skipped ARIA labels; upgrade when accessibility audit lands -->\n</div>\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, 'decoy.js'),
    "const s = \"eco: not a real marker, just text in a string\";\n",
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('finds markers across //, #, <!-- comment styles and skips string decoy', () => {
  const result = spawnSync('node', [SCRIPT_PATH, tmpDir], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('app.js');
  expect(result.stdout).toContain('skipped input validation');
  expect(result.stdout).toContain('script.sh');
  expect(result.stdout).toContain('skipped retry logic');
  expect(result.stdout).toContain('page.html');
  expect(result.stdout).toContain('skipped ARIA labels');
  expect(result.stdout).not.toContain('not a real marker');
});

test('--json emits machine-readable ledger with path:line entries', () => {
  const result = spawnSync('node', [SCRIPT_PATH, tmpDir, '--json'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(3);
  for (const entry of parsed) {
    expect(entry).toHaveProperty('file');
    expect(entry).toHaveProperty('line');
    expect(entry).toHaveProperty('text');
  }
});

test('exits 0 with "no markers" message when none found', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-debt-empty-'));
  const result = spawnSync('node', [SCRIPT_PATH, emptyDir], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout.toLowerCase()).toContain('no markers');
  fs.rmSync(emptyDir, { recursive: true, force: true });
});
