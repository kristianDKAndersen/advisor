import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// U7 Phase 3 Wave 1: Stop hook handover snapshot (pattern 3.9).
// .claude/hooks/stop-handover.js does NOT yet exist — all tests are intentionally RED.

const HOOK_PATH = path.resolve(import.meta.dir, '../.claude/hooks/stop-handover.js');

const tmpDirs = [];

function makeTmpHome(sid) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-stop-handover-'));
  tmpDirs.push(tmpHome);
  const runDir = path.join(tmpHome, '.advisor', 'runs', sid);
  fs.mkdirSync(runDir, { recursive: true });
  return { tmpHome, runDir };
}

function invokeHook(stdinPayload, tmpHome) {
  return spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(stdinPayload),
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf8',
  });
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Scenario 1: happy path — session.json present ──────────────────────────

const sid1 = 'test-handover-happy-' + Date.now();
const { tmpHome: home1, runDir: runDir1 } = makeTmpHome(sid1);

const sessionData1 = {
  next_action: 'run the final synthesis pass',
  memory_blocks: { context: 'important context', phase: 3 },
};
fs.writeFileSync(path.join(runDir1, 'session.json'), JSON.stringify(sessionData1));

const result1 = invokeHook({ session_id: sid1, transcript_path: '/dev/null' }, home1);
const snapshotPath1 = path.join(runDir1, 'handover-snapshot.json');

let snapshot1 = null;
try { snapshot1 = JSON.parse(fs.readFileSync(snapshotPath1, 'utf8')); } catch (_) {}

test('happy path: hook exits 0', () => {
  expect(result1.status).toBe(0);
});

test('happy path: handover-snapshot.json is written', () => {
  expect(fs.existsSync(snapshotPath1)).toBe(true);
});

test('happy path: snapshot parses as valid JSON object', () => {
  expect(snapshot1).not.toBeNull();
  expect(typeof snapshot1).toBe('object');
});

test('happy path: snapshot.sid is a string', () => {
  expect(typeof snapshot1.sid).toBe('string');
});

test('happy path: snapshot.sid equals the session_id', () => {
  expect(snapshot1.sid).toBe(sid1);
});

test('happy path: snapshot.ts is a number', () => {
  expect(typeof snapshot1.ts).toBe('number');
});

test('happy path: snapshot.next_action is a string', () => {
  expect(typeof snapshot1.next_action).toBe('string');
});

test('happy path: snapshot.next_action matches session.next_action', () => {
  expect(snapshot1.next_action).toBe(sessionData1.next_action);
});

test('happy path: snapshot.memory_blocks is a non-null object', () => {
  expect(snapshot1.memory_blocks).not.toBeNull();
  expect(typeof snapshot1.memory_blocks).toBe('object');
});

test('happy path: snapshot.memory_blocks matches session.memory_blocks', () => {
  expect(snapshot1.memory_blocks).toEqual(sessionData1.memory_blocks);
});

test('happy path: snapshot.last_modified_at is a number', () => {
  expect(typeof snapshot1.last_modified_at).toBe('number');
});

test('happy path: snapshot has exactly the five required top-level keys', () => {
  const keys = Object.keys(snapshot1).sort();
  expect(keys).toEqual(['last_modified_at', 'memory_blocks', 'next_action', 'sid', 'ts']);
});

// ── Scenario 2: missing session.json — graceful fallback ───────────────────

const sid2 = 'test-handover-missing-' + Date.now();
const { tmpHome: home2, runDir: runDir2 } = makeTmpHome(sid2);
// session.json intentionally absent

const result2 = invokeHook({ session_id: sid2, transcript_path: '/dev/null' }, home2);
const snapshotPath2 = path.join(runDir2, 'handover-snapshot.json');

let snapshot2 = null;
try { snapshot2 = JSON.parse(fs.readFileSync(snapshotPath2, 'utf8')); } catch (_) {}

test('fallback: hook exits 0 when session.json is missing', () => {
  expect(result2.status).toBe(0);
});

test('fallback: handover-snapshot.json is still written', () => {
  expect(fs.existsSync(snapshotPath2)).toBe(true);
});

test('fallback: snapshot parses as valid JSON object', () => {
  expect(snapshot2).not.toBeNull();
  expect(typeof snapshot2).toBe('object');
});

test('fallback: snapshot.next_action is empty string', () => {
  expect(snapshot2.next_action).toBe('');
});

test('fallback: snapshot.memory_blocks is null', () => {
  expect(snapshot2.memory_blocks).toBeNull();
});

test('fallback: snapshot.sid is the session_id', () => {
  expect(snapshot2.sid).toBe(sid2);
});

test('fallback: snapshot.ts is a number', () => {
  expect(typeof snapshot2.ts).toBe('number');
});

test('fallback: snapshot.last_modified_at is a number', () => {
  expect(typeof snapshot2.last_modified_at).toBe('number');
});

// ── Scenario 3: overwrite — second invocation replaces existing snapshot ───

const sid3 = 'test-handover-overwrite-' + Date.now();
const { tmpHome: home3, runDir: runDir3 } = makeTmpHome(sid3);

const sessionDataV1 = { next_action: 'first action', memory_blocks: { v: 1 } };
const sessionDataV2 = { next_action: 'second action', memory_blocks: { v: 2 } };

fs.writeFileSync(path.join(runDir3, 'session.json'), JSON.stringify(sessionDataV1));
invokeHook({ session_id: sid3, transcript_path: '/dev/null' }, home3);

// Replace session.json and invoke again — snapshot must be overwritten.
fs.writeFileSync(path.join(runDir3, 'session.json'), JSON.stringify(sessionDataV2));
const result3 = invokeHook({ session_id: sid3, transcript_path: '/dev/null' }, home3);
const snapshotPath3 = path.join(runDir3, 'handover-snapshot.json');

let snapshot3 = null;
try { snapshot3 = JSON.parse(fs.readFileSync(snapshotPath3, 'utf8')); } catch (_) {}

test('overwrite: second invocation exits 0', () => {
  expect(result3.status).toBe(0);
});

test('overwrite: handover-snapshot.json exists after second invocation', () => {
  expect(fs.existsSync(snapshotPath3)).toBe(true);
});

test('overwrite: snapshot.next_action reflects second invocation', () => {
  expect(snapshot3.next_action).toBe(sessionDataV2.next_action);
});

test('overwrite: snapshot.memory_blocks reflects second invocation', () => {
  expect(snapshot3.memory_blocks).toEqual(sessionDataV2.memory_blocks);
});
