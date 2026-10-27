const { test, expect } = require('bun:test');
const { splitSentences, splitEntries, splitRow } = require('../lib/sentences.js');

const texts = (content, opts) => splitSentences(content, opts).map((s) => s.sentence);

test('splits on . ! ? and tracks the starting line', () => {
  expect(splitSentences('One. Two!\nThree?')).toEqual([
    { sentence: 'One.', line: 1, endLine: 1 },
    { sentence: 'Two!', line: 1, endLine: 1 },
    { sentence: 'Three?', line: 2, endLine: 2 },
  ]);
});

test('joins wrapped paragraph lines and reports start and end lines', () => {
  expect(splitSentences('alpha beta\ngamma delta. Next')).toEqual([
    { sentence: 'alpha beta gamma delta.', line: 1, endLine: 2 },
    { sentence: 'Next', line: 2, endLine: 2 },
  ]);
});

test('skips fenced code, backtick and tilde', () => {
  expect(texts('Before.\n```\nin fence. x\n```\nAfter.\n~~~\nhidden.\n~~~\nEnd.')).toEqual(['Before.', 'After.', 'End.']);
});

test('strips list, quote and heading markers and splits items apart', () => {
  expect(texts('# Title\n- one\n* two\n1. three\n2) four\n\n> quoted')).toEqual(['Title', 'one', 'two', 'three', 'four', 'quoted']);
});

test('does not split after e.g. i.e. vs.', () => {
  expect(texts('Use a tool, e.g. grep. Or i.e. sed vs. awk here.')).toEqual(['Use a tool, e.g. grep.', 'Or i.e. sed vs. awk here.']);
});

test('table: header and separator rows are skipped, each body row is one sentence', () => {
  const t = '| id | claim |\n|---|:-:|\n| A1 | first. part |\n| A2 |  second   |\nAfter.';
  expect(splitSentences(t)).toEqual([
    { sentence: 'A1 | first. part', line: 3, endLine: 3 },
    { sentence: 'A2 | second', line: 4, endLine: 4 },
    { sentence: 'After.', line: 5, endLine: 5 },
  ]);
});

test('table: escaped pipe stays inside its cell', () => {
  expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  expect(texts('| h | h |\n|---|---|\n| x \\| y | z |')).toEqual(['x | y | z']);
});

test('table rows are skipped when tableRows is false', () => {
  expect(texts('| h |\n|---|\n| row |\nText.', { tableRows: false })).toEqual(['Text.']);
});

test('fences option off leaves fence lines to the caller', () => {
  expect(splitEntries([{ line: 1, text: '```' }, { line: 2, text: 'code.' }], { fences: false }).map((s) => s.sentence)).toEqual(['``` code.']);
});
