const { test, expect } = require('bun:test');
const { append } = require('./channel.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('append truncates result body.summary to 200 chars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-test-'));
  const p = path.join(dir, 'inbox.jsonl');
  const longSummary = 'x'.repeat(250);

  append(p, { type: 'result', body: { summary: longSummary, verdict: 'complete', paths: [] }, from: 'coder' });

  const line = fs.readFileSync(p, 'utf8').trim();
  const msg = JSON.parse(line);

  expect(msg.body.summary.length).toBe(200);
  expect(msg.body.summary.endsWith('...')).toBe(true);

  fs.rmSync(dir, { recursive: true });
});

test('append does not mutate caller msg object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-test-'));
  const p = path.join(dir, 'inbox.jsonl');
  const longSummary = 'y'.repeat(250);
  const body = { summary: longSummary, verdict: 'complete', paths: [] };
  const msg = { type: 'result', body, from: 'coder' };

  append(p, msg);

  expect(msg.body.summary.length).toBe(250);

  fs.rmSync(dir, { recursive: true });
});

test('append does not truncate summary at exactly 200 chars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-test-'));
  const p = path.join(dir, 'inbox.jsonl');
  const exactSummary = 'z'.repeat(200);

  append(p, { type: 'result', body: { summary: exactSummary, verdict: 'complete', paths: [] }, from: 'coder' });

  const line = fs.readFileSync(p, 'utf8').trim();
  const msg = JSON.parse(line);

  expect(msg.body.summary.length).toBe(200);
  expect(msg.body.summary.endsWith('...')).toBe(false);

  fs.rmSync(dir, { recursive: true });
});

test('append does not truncate non-result type messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-test-'));
  const p = path.join(dir, 'inbox.jsonl');
  const longSummary = 'a'.repeat(250);

  append(p, { type: 'progress', body: { summary: longSummary }, from: 'coder' });

  const line = fs.readFileSync(p, 'utf8').trim();
  const msg = JSON.parse(line);

  expect(msg.body.summary.length).toBe(250);

  fs.rmSync(dir, { recursive: true });
});
