import { test, expect } from 'bun:test';

import {
  canonicalHash,
  checkDuplicate,
  resetState,
  isProtectedWrite,
  bashWritesToProtected,
} from '../lib/tool-guard.js';

test('canonicalHash returns a stable SHA256 hex string for the same args', () => {
  const h1 = canonicalHash('Bash', { command: 'ls -la' });
  const h2 = canonicalHash('Bash', { command: 'ls -la' });
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
});

test('canonicalHash returns different hashes for different args', () => {
  const h1 = canonicalHash('Bash', { command: 'ls' });
  const h2 = canonicalHash('Bash', { command: 'pwd' });
  expect(h1).not.toBe(h2);
});

test('checkDuplicate returns false on first call for a unique hash', () => {
  resetState();
  const result = checkDuplicate('Bash', { command: 'echo unique-1' });
  expect(result.duplicate).toBe(false);
  expect(result.count).toBe(1);
});

test('checkDuplicate returns true after N=3 identical calls and signals halt', () => {
  resetState();
  const args = { command: 'echo dedup-test' };
  checkDuplicate('Bash', args); // 1
  checkDuplicate('Bash', args); // 2
  const third = checkDuplicate('Bash', args); // 3
  expect(third.duplicate).toBe(true);
  expect(third.halt).toBe(true);
  expect(third.count).toBe(3);
});

test('checkDuplicate counts are per tool+args combination, not global', () => {
  resetState();
  checkDuplicate('Bash', { command: 'echo a' });
  checkDuplicate('Bash', { command: 'echo a' });
  const other = checkDuplicate('Read', { file_path: '/tmp/foo' });
  expect(other.count).toBe(1);
  expect(other.halt).toBeFalsy();
});

// isProtectedWrite tests
test('isProtectedWrite blocks Edit to a protected path', () => {
  expect(isProtectedWrite('Edit', '/tmp/my.test.js', ['/tmp/my.test.js'])).toBe(true);
});

test('isProtectedWrite blocks Write to a protected path', () => {
  expect(isProtectedWrite('Write', '/tmp/my.test.js', ['/tmp/my.test.js'])).toBe(true);
});

test('isProtectedWrite blocks NotebookEdit to a protected path', () => {
  expect(isProtectedWrite('NotebookEdit', '/tmp/my.test.js', ['/tmp/my.test.js'])).toBe(true);
});

test('isProtectedWrite allows Read to a protected path', () => {
  expect(isProtectedWrite('Read', '/tmp/my.test.js', ['/tmp/my.test.js'])).toBe(false);
});

test('isProtectedWrite allows Edit to a non-protected path', () => {
  expect(isProtectedWrite('Edit', '/tmp/other.js', ['/tmp/my.test.js'])).toBe(false);
});

test('isProtectedWrite is inert when protectedList is empty', () => {
  expect(isProtectedWrite('Edit', '/tmp/my.test.js', [])).toBe(false);
});

test('isProtectedWrite is inert when protectedList is null', () => {
  expect(isProtectedWrite('Edit', '/tmp/my.test.js', null)).toBe(false);
});

// ---------------------------------------------------------------------------
// bashWritesToProtected — allow/block matrix
// ---------------------------------------------------------------------------

const PROT = '/tmp/spec/tool-guard.test.js';
const PLIST = [PROT];

// Inert cases
test('bashWritesToProtected is inert when protectedList is null', () => {
  expect(bashWritesToProtected(`echo x > ${PROT}`, null)).toBe(false);
});

test('bashWritesToProtected is inert when protectedList is empty', () => {
  expect(bashWritesToProtected(`echo x > ${PROT}`, [])).toBe(false);
});

test('bashWritesToProtected is inert when command is empty string', () => {
  expect(bashWritesToProtected('', PLIST)).toBe(false);
});

test('bashWritesToProtected is inert when path does not appear in command', () => {
  expect(bashWritesToProtected('echo hello > /tmp/other.js', PLIST)).toBe(false);
});

// --- BLOCK cases ---

test('bashWritesToProtected blocks stdout redirect >', () => {
  expect(bashWritesToProtected(`echo foo > ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks stdout append redirect >>', () => {
  expect(bashWritesToProtected(`echo foo >> ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks tee without flags', () => {
  expect(bashWritesToProtected(`some-cmd | tee ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks tee -a (append)', () => {
  expect(bashWritesToProtected(`some-cmd | tee -a ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks sed -i (in-place)', () => {
  expect(bashWritesToProtected(`sed -i 's/foo/bar/' ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks cp when protected is destination', () => {
  expect(bashWritesToProtected(`cp /tmp/other.js ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks mv when protected is destination', () => {
  expect(bashWritesToProtected(`mv /tmp/other.js ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks dd of=path', () => {
  expect(bashWritesToProtected(`dd if=/dev/null of=${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks chmod', () => {
  expect(bashWritesToProtected(`chmod 644 ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks chflags', () => {
  expect(bashWritesToProtected(`chflags nouchg ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks truncate', () => {
  expect(bashWritesToProtected(`truncate -s 0 ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks ed (line editor)', () => {
  expect(bashWritesToProtected(`ed ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks perl -i (in-place)', () => {
  expect(bashWritesToProtected(`perl -i -pe 's/foo/bar/' ${PROT}`, PLIST)).toBe(true);
});

test('bashWritesToProtected blocks python3 -c that references protected path', () => {
  expect(bashWritesToProtected(`python3 -c "open('${PROT}', 'w').write('x')"`, PLIST)).toBe(true);
});

// --- ALLOW cases ---

test('bashWritesToProtected allows bun test with protected path', () => {
  expect(bashWritesToProtected(`bun test ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows cat of protected path', () => {
  expect(bashWritesToProtected(`cat ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows grep on protected path', () => {
  expect(bashWritesToProtected(`grep foo ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows head of protected path', () => {
  expect(bashWritesToProtected(`head -n 20 ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows tail of protected path', () => {
  expect(bashWritesToProtected(`tail -f ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows diff with protected path', () => {
  expect(bashWritesToProtected(`diff ${PROT} /tmp/other.js`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows git diff with protected path', () => {
  expect(bashWritesToProtected(`git diff ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows wc on protected path', () => {
  expect(bashWritesToProtected(`wc -l ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows node executing protected path as script', () => {
  expect(bashWritesToProtected(`node ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows python3 executing protected path as script', () => {
  expect(bashWritesToProtected(`python3 ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows cp FROM protected path (source, not dest)', () => {
  expect(bashWritesToProtected(`cp ${PROT} /tmp/backup.js`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows stat on protected path', () => {
  expect(bashWritesToProtected(`stat ${PROT}`, PLIST)).toBe(false);
});

test('bashWritesToProtected allows ls of protected path', () => {
  expect(bashWritesToProtected(`ls -la ${PROT}`, PLIST)).toBe(false);
});
