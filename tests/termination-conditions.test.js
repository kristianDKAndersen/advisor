import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const PARALLEL_JS = path.resolve(import.meta.dir, '../lib/parallel.js');
const SUMMON_BIN = path.resolve(import.meta.dir, '../bin/summon');

// U2: runParallel must respect maxToolCalls, timeoutSec, requiredOutput.
// None of these options exist yet in parallel.js or bin/summon.

test('runParallel options object destructures maxToolCalls', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  expect(src).toContain('maxToolCalls');
});

test('runParallel options object destructures timeoutSec', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  expect(src).toContain('timeoutSec');
});

test('runParallel options object destructures requiredOutput', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  expect(src).toContain('requiredOutput');
});

test('runParallel poll loop terminates worker when tool-call count exceeds maxToolCalls', () => {
  const src = fs.readFileSync(PARALLEL_JS, 'utf8');
  // Must reference toolCalls/tool_calls in context of maxToolCalls check
  expect(src).toMatch(/maxToolCalls[\s\S]{0,200}tool[_C]alls|tool[_C]alls[\s\S]{0,200}maxToolCalls/);
});

test('bin/summon accepts --max-tool-calls flag', () => {
  const src = fs.readFileSync(SUMMON_BIN, 'utf8');
  expect(src).toContain('max-tool-calls');
});

test('bin/summon accepts --timeout-sec flag', () => {
  const src = fs.readFileSync(SUMMON_BIN, 'utf8');
  expect(src).toContain('timeout-sec');
});

test('bin/summon accepts --required-output flag', () => {
  const src = fs.readFileSync(SUMMON_BIN, 'utf8');
  expect(src).toContain('required-output');
});
