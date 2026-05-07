import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

let session;
let tmpRunsRoot;

beforeAll(async () => {
  tmpRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-blocks-test-'));
  process.env.ADVISOR_RUNS_ROOT = tmpRunsRoot;
  session = await import('../lib/session.js');
});

afterAll(() => {
  fs.rmSync(tmpRunsRoot, { recursive: true, force: true });
  delete process.env.ADVISOR_RUNS_ROOT;
});

test('SESSION_SCHEMA_VERSION is 2', () => {
  expect(session.SESSION_SCHEMA_VERSION).toBe(2);
});

test('defaultSessionState returns memory_blocks with exactly 4 keys and full nested shape', () => {
  const state = session.defaultSessionState('test-sid');
  expect(Object.keys(state.memory_blocks).sort()).toEqual(
    ['decisions_block', 'gaps_block', 'task_block', 'verdict_block']
  );
  expect(state.memory_blocks.task_block).toEqual({ char_limit: 2000, content: '' });
  expect(state.memory_blocks.decisions_block).toEqual({ char_limit: 2000, content: '' });
  expect(state.memory_blocks.gaps_block).toEqual({ char_limit: 2000, content: '' });
  expect(state.memory_blocks.verdict_block).toEqual({ char_limit: 1000, content: '' });
});

test('updateMemoryBlock is a named export function', () => {
  expect(typeof session.updateMemoryBlock).toBe('function');
});

test('updateMemoryBlock writes content and round-trips via readSessionState', () => {
  const sid = 'mem-test-roundtrip-' + Date.now();
  session.writeSessionState(sid, session.defaultSessionState(sid));

  session.updateMemoryBlock(sid, 'task_block', 'hello world');
  const state = session.readSessionState(sid);
  expect(state.memory_blocks.task_block.content).toBe('hello world');
});

test('updateMemoryBlock truncates content at char_limit (task_block=2000)', () => {
  const sid = 'mem-test-trunc-task-' + Date.now();
  session.writeSessionState(sid, session.defaultSessionState(sid));

  const overLimit = 'a'.repeat(3000);
  session.updateMemoryBlock(sid, 'task_block', overLimit);
  const state = session.readSessionState(sid);
  expect(state.memory_blocks.task_block.content).toBe('a'.repeat(2000));
});

test('updateMemoryBlock truncates content at char_limit (verdict_block=1000)', () => {
  const sid = 'mem-test-trunc-verdict-' + Date.now();
  session.writeSessionState(sid, session.defaultSessionState(sid));

  const overLimit = 'v'.repeat(1500);
  session.updateMemoryBlock(sid, 'verdict_block', overLimit);
  const state = session.readSessionState(sid);
  expect(state.memory_blocks.verdict_block.content).toBe('v'.repeat(1000));
});

test('updateMemoryBlock with unknown blockName throws or no-ops without corrupting state', () => {
  const sid = 'mem-test-unknown-' + Date.now();
  session.writeSessionState(sid, session.defaultSessionState(sid));

  let threw = false;
  try {
    session.updateMemoryBlock(sid, 'nonexistent_block', 'bad content');
  } catch (_) {
    threw = true;
  }

  if (!threw) {
    // no-op path: existing blocks must be intact
    const state = session.readSessionState(sid);
    expect(state.memory_blocks.task_block).toEqual({ char_limit: 2000, content: '' });
    expect(state.memory_blocks.verdict_block).toEqual({ char_limit: 1000, content: '' });
    // unknown block must NOT appear in memory_blocks
    expect(Object.keys(state.memory_blocks)).not.toContain('nonexistent_block');
  }
  // either path (threw or no-op) is acceptable
  expect(threw || true).toBe(true);
});
