import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = path.resolve(import.meta.dir, '../.claude/hooks/capture-correction.js');

let tmp, vault, file;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-correction-'));
  vault = path.join(tmp, 'vault');
  file = path.join(vault, '.cache', 'corrections.jsonl');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(input, extraEnv = {}, raw = false) {
  const stdin = raw ? input : JSON.stringify({ prompt: input, session_id: 'sid-1' });
  return spawnSync('node', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_VAULT: vault, ...extraEnv },
  });
}
function lines() {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// Safety req #1 + #2: stdout byte-empty and exit 0 on every path.
test('stdout empty + exit 0 on all five safety cases', () => {
  let r = run("no, that's wrong");                       // matching
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  r = run('please add a test for the parser');           // non-matching
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  r = run('', {}, true);                                 // empty stdin
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  r = run('{not json', {}, true);                        // malformed JSON
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  const blocker = path.join(tmp, 'blocker');             // unwritable target dir
  fs.writeFileSync(blocker, 'x');
  r = run("no, that's wrong", { ADVISOR_VAULT: path.join(blocker, 'nope') });
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
});

test('captures a clear correction with target=advisor + matched_pattern', () => {
  const r = run("no, that's wrong");
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  const l = lines();
  expect(l.length).toBe(1);
  const e = JSON.parse(l[0]);
  expect(e.target).toBe('advisor');
  expect(e.confidence).toBe(0.75);
  expect(typeof e.matched_pattern).toBe('string');
  expect(e.matched_pattern.length).toBeGreaterThan(0);
  expect(e.text).toContain('wrong');
});

test('captures "I already told you..." via the told-you pattern', () => {
  run('I already told you to use tabs');
  const l = lines();
  expect(l.length).toBe(1);
  expect(JSON.parse(l[0]).matched_pattern).toContain('told-you');
});

// detector_quality: ordinary forward-looking instructions must NOT be captured.
test('ordinary imperative instructions are NOT captured', () => {
  const ordinary = [
    "don't push yet",
    "never commit to master",
    "use Edit not Write",
    'run the tests again',
    'stop the dev server',
    'revert the last migration',
    'no rush, take your time',
  ];
  for (const p of ordinary) {
    const r = run(p);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }
  expect(lines().length).toBe(0);
});

test('clear corrections ARE captured', () => {
  const corrections = [
    "no, that's wrong",
    'I already told you to do it',
    "no, don't scaffold it that way",
    "that's not what I asked for",
    'undo that change',
  ];
  for (const p of corrections) run(p);
  expect(lines().length).toBe(corrections.length);
});

test('ADVISOR_CAPTURE=0 disables capture entirely', () => {
  const r = run("no, that's wrong", { ADVISOR_CAPTURE: '0' });
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  expect(lines().length).toBe(0);
});

// Safety req #5: bounded growth — rotate once at the cap.
test('rotates once at the size cap (bounded growth)', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(200) + '\n');
  const r = run("no, that's wrong", { ADVISOR_CORRECTIONS_MAX_BYTES: '50' });
  expect(r.status).toBe(0);
  expect(fs.existsSync(file + '.1')).toBe(true);
  expect(lines().length).toBe(1);
});

test('over-length prompt is ignored', () => {
  run('no, ' + 'x'.repeat(600));
  expect(lines().length).toBe(0);
});
