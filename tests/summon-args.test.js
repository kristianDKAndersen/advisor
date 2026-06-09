import { test, expect } from 'bun:test';
import fs from 'fs';
import { fileURLToPath } from 'url';

const SUMMON_PATH = fileURLToPath(new URL('../lib/summon.js', import.meta.url));

function loadParseArgs() {
  const src = fs.readFileSync(SUMMON_PATH, 'utf8');
  const start = src.indexOf('function parseArgs(argv)');
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return new Function('return ' + src.slice(start, i + 1))();
}

const parseArgs = loadParseArgs();

test('parseArgs: does not consume next --flag as value for previous flag', () => {
  const result = parseArgs(['node', 'summon.js', '--agent', '--task', 'foo']);
  expect(result.agent).toBe(true);
  expect(result.task).toBe('foo');
});

test('parseArgs: undefined next arg sets flag to true', () => {
  const result = parseArgs(['node', 'summon.js', '--verbose']);
  expect(result.verbose).toBe(true);
});

test('parseArgs: value after flag starting with non-dash is assigned correctly', () => {
  const result = parseArgs(['node', 'summon.js', '--agent', 'coder', '--task', 'do something']);
  expect(result.agent).toBe('coder');
  expect(result.task).toBe('do something');
});
