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

// ─── Lossy compaction (recv --compact=lossy) ───────────────────────────────
//
// compactChannelRecordsLossy collapses each contiguous run of 'progress'
// records (keep first + last, replace the middle with an explicit
// 'N progress records elided' marker record), then applies the lossless
// columnar encoding. task / result / guidance / question records survive
// VERBATIM through expandChannelCompact. Elision is always marked, never a
// silent drop.

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compactChannelRecordsLossy } = require('../lib/compactor');

// Long mostly-progress worker session: 1 task, 24 progress, 1 guidance,
// 24 progress, 1 question, 1 structured result+meta = 52 records.
function buildLongProgressFixture() {
  const t0 = 1781100000;
  const records = [];
  let seq = 1;
  records.push({
    ts: t0, type: 'task', from: 'advisor', seq: seq++,
    body: '<objective>Apply 48 review fixes to lib/parser.js per review.md, severity order</objective>',
  });
  for (let i = 1; i <= 24; i++) {
    records.push({
      ts: t0 + i * 30, type: 'progress', from: 'coder', seq: seq++,
      body: `Fixed B${i}: lib/parser.js - re-ran bun test tests/parser.test.js, 42 pass 0 fail (exit 0); node --check clean`,
    });
  }
  records.push({
    ts: t0 + 1000, type: 'guidance', from: 'advisor', seq: seq++,
    body: 'Skip B25-B27: spec diverged, reviewer re-checking those lines. Continue with warnings.',
  });
  for (let i = 25; i <= 48; i++) {
    records.push({
      ts: t0 + 1000 + (i - 24) * 30, type: 'progress', from: 'coder', seq: seq++,
      body: `Fixed W${i}: lib/parser.js - re-ran bun test tests/parser.test.js, 42 pass 0 fail (exit 0); node --check clean`,
    });
  }
  records.push({
    ts: t0 + 2000, type: 'question', from: 'coder', seq: seq++,
    body: 'W40 names line 412 but the function moved to lib/parser2.js - apply there or skip?',
  });
  records.push({
    ts: t0 + 2100, type: 'result', from: 'coder', seq: seq++,
    body: { summary: 'Applied 48/51 fixes.', paths: ['/tmp/out/changes.md'], verdict: 'partial' },
    meta: { tool_calls: 60 },
  });
  return records;
}

test('lossy: >=85% reduction on a long mostly-progress history, elision marked in header', () => {
  const records = buildLongProgressFixture();
  const original = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  const lossy = compactChannelRecordsLossy(records);
  const before = Buffer.byteLength(original);
  const after = Buffer.byteLength(lossy);
  const reduction = 1 - after / before;
  console.log(`lossy fixture: ${before} -> ${after} bytes (${(reduction * 100).toFixed(1)}% reduction)`);
  expect(reduction).toBeGreaterThanOrEqual(0.85);
  expect(lossy.split('\n')[1]).toBe('#lossy elided=44 of=52');
});

test('lossy: task/result/guidance/question verbatim; first+last progress kept; elision marked', () => {
  const records = buildLongProgressFixture();
  const expanded = expandChannelCompact(compactChannelRecordsLossy(records));
  // every non-progress record survives verbatim
  for (const r of records) {
    if (['task', 'result', 'guidance', 'question'].includes(r.type)) {
      const e = expanded.find(x => x.seq === r.seq);
      expect(e.type).toBe(r.type);
      expect(e.from).toBe(r.from);
      expect(e.body).toEqual(r.body);
      if (r.meta) expect(e.meta).toEqual(r.meta);
    }
  }
  // first and last progress of each contiguous run survive verbatim
  for (const seq of [2, 25, 27, 50]) {
    const orig = records.find(r => r.seq === seq);
    const e = expanded.find(x => x.seq === seq);
    expect(e.type).toBe('progress');
    expect(e.body).toBe(orig.body);
  }
  // explicit markers, never a silent drop: counts reconcile to the original
  const markers = expanded.filter(x => x.type === 'elided');
  expect(markers.length).toBe(2);
  expect(markers[0].body).toBe('22 progress records elided (seq 3..24)');
  expect(markers[1].body).toBe('22 progress records elided (seq 28..49)');
  const elidedTotal = markers.reduce((s, m) => s + parseInt(m.body, 10), 0);
  expect(elidedTotal + expanded.filter(x => x.type !== 'elided').length).toBe(records.length);
});

test('lossy: short progress runs (<=2) pass through untouched, no marker', () => {
  const t0 = 1781100000;
  const records = [
    { ts: t0, type: 'task', from: 'advisor', seq: 1, body: 'do the thing' },
    { ts: t0 + 1, type: 'progress', from: 'coder', seq: 2, body: 'started' },
    { ts: t0 + 2, type: 'progress', from: 'coder', seq: 3, body: 'almost done' },
    { ts: t0 + 3, type: 'result', from: 'coder', seq: 4, body: 'done' },
  ];
  const expanded = expandChannelCompact(compactChannelRecordsLossy(records));
  expect(expanded.length).toBe(4);
  expect(expanded.map(r => r.body)).toEqual(['do the thing', 'started', 'almost done', 'done']);
  expect(expanded.some(r => r.type === 'elided')).toBe(false);
});

test('CLI: recv --compact=lossy emits lossy form; plain --compact stays lossless', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cchan-lossy-'));
  const file = path.join(dir, 'outbox.jsonl');
  const records = buildLongProgressFixture();
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const channel = require.resolve('../lib/channel.js');

  const lossy = spawnSync('bun', [channel, 'recv', '--file', file, '--compact=lossy'], { encoding: 'utf8' });
  expect(lossy.status).toBe(0);
  expect(lossy.stdout).toContain('#lossy elided=44 of=52');
  const expanded = expandChannelCompact(lossy.stdout);
  expect(expanded.find(r => r.type === 'task').body).toBe(records[0].body);
  expect(expanded.filter(r => r.type === 'elided').length).toBe(2);

  const lossless = spawnSync('bun', [channel, 'recv', '--file', file, '--compact'], { encoding: 'utf8' });
  expect(lossless.status).toBe(0);
  expect(lossless.stdout.startsWith('#cchan v1')).toBe(true);
  expect(lossless.stdout).not.toContain('#lossy');
  expect(expandChannelCompact(lossless.stdout).length).toBe(records.length);
});
