// tests/channel-compact.test.js — SmartCrusher-style channel JSONL compaction.
//
// TDD spec for compactChannelRecords/expandChannelCompact (lib/compactor.js):
//   1. >50% size reduction on a repetitive multi-record JSONL fixture
//   2. probe fact (a specific field value) recoverable from the compact form
//   3. lossless roundtrip on a real channel file (presentation transform only —
//      the on-disk JSONL and wire protocol are never touched)

const { test, expect } = require('bun:test');
const fs = require('fs');
const { compactChannelRecords, expandChannelCompact } = require('../lib/compactor');

// Realistic worker-session shape: 1 task, 12 templated progress reports,
// 6 identical heartbeats, 1 probe-bearing progress, 1 structured result+meta.
function buildFixture() {
  const t0 = 1781000000;
  const records = [];
  let seq = 1;
  records.push({
    ts: t0, type: 'task', from: 'advisor', seq: seq++,
    body: '<objective>Apply 12 review fixes to lib/parser.js per review.md</objective>',
  });
  for (let i = 1; i <= 12; i++) {
    records.push({
      ts: t0 + i * 30.5, type: 'progress', from: 'coder', seq: seq++,
      body: `Fixed fix-${i}: re-ran suite, green (tests/parser.test.js)`,
    });
  }
  for (let i = 0; i < 6; i++) {
    records.push({
      ts: t0 + 400 + i, type: 'progress', from: 'coder', seq: seq++,
      body: 'heartbeat: still working',
    });
  }
  records.push({
    ts: t0 + 500.2, type: 'progress', from: 'coder', seq: seq++,
    body: 'Fixed fix-7f3a: re-ran suite, green (tests/parser.test.js)',
  });
  records.push({
    ts: t0 + 600, type: 'result', from: 'coder', seq: seq++,
    body: { summary: 'Applied 12/12 fixes.', paths: ['/tmp/out/changes.md'], verdict: 'complete' },
    meta: { tool_calls: 18, token_estimate: 4200 },
  });
  return records;
}

test('compactChannelRecords: >50% size reduction on repetitive multi-record JSONL', () => {
  const records = buildFixture();
  const original = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  const compact = compactChannelRecords(records);
  const before = Buffer.byteLength(original);
  const after = Buffer.byteLength(compact);
  const reduction = 1 - after / before;
  console.log(`fixture: ${before} -> ${after} bytes (${(reduction * 100).toFixed(1)}% reduction)`);
  expect(reduction).toBeGreaterThan(0.5);
});

test('probe fact and every record (seq/type/from/body) recoverable from compact form', () => {
  const records = buildFixture();
  const expanded = expandChannelCompact(compactChannelRecords(records));
  expect(expanded.length).toBe(records.length);
  for (let i = 0; i < records.length; i++) {
    expect(expanded[i].seq).toBe(records[i].seq);
    expect(expanded[i].type).toBe(records[i].type);
    expect(expanded[i].from).toBe(records[i].from);
    expect(expanded[i].body).toEqual(records[i].body);
    expect(Math.abs(expanded[i].ts - records[i].ts)).toBeLessThan(0.06);
  }
  // probe fact: the unique marker buried mid-stream in a templated body
  const probe = expanded.find(r => r.seq === 20);
  expect(probe.body).toBe('Fixed fix-7f3a: re-ran suite, green (tests/parser.test.js)');
  // structured result envelope + extra meta key survive
  const res = expanded.find(r => r.type === 'result');
  expect(res.body.verdict).toBe('complete');
  expect(res.body.paths).toEqual(['/tmp/out/changes.md']);
  expect(res.meta.tool_calls).toBe(18);
});

const REAL = '/Users/awesome/.advisor/runs/1779885887-bc6f59/channel/outbox.jsonl';
(fs.existsSync(REAL) ? test : test.skip)('real channel file: lossless roundtrip + material reduction', () => {
  const raw = fs.readFileSync(REAL, 'utf8');
  const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const compact = compactChannelRecords(records);
  const expanded = expandChannelCompact(compact);
  expect(expanded.length).toBe(records.length);
  for (let i = 0; i < records.length; i++) {
    expect(expanded[i].seq).toBe(records[i].seq);
    expect(expanded[i].type).toBe(records[i].type);
    expect(expanded[i].from).toBe(records[i].from);
    expect(expanded[i].body).toEqual(records[i].body);
  }
  const before = Buffer.byteLength(raw);
  const after = Buffer.byteLength(compact);
  console.log(`real ${REAL}: ${before} -> ${after} bytes (${((1 - after / before) * 100).toFixed(1)}% reduction)`);
  expect(after).toBeLessThan(before * 0.7);
});

test('empty input produces a valid empty compact form', () => {
  expect(expandChannelCompact(compactChannelRecords([]))).toEqual([]);
});
