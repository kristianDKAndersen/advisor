import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildRows, estimateCost, priceForModel, lastPerSid, normalizeEntry } from '../bin/advisor-cost';

describe('priceForModel', () => {
  it('returns haiku rates', () => {
    const p = priceForModel('claude-haiku-4-5-20251001');
    expect(p.input).toBe(0.80);
    expect(p.output).toBe(4.00);
  });
  it('returns sonnet rates', () => {
    const p = priceForModel('claude-sonnet-4-6');
    expect(p.input).toBe(3.00);
    expect(p.output).toBe(15.00);
  });
  it('returns opus rates', () => {
    const p = priceForModel('claude-opus-4-8');
    expect(p.input).toBe(15.00);
    expect(p.output).toBe(75.00);
  });
  it('returns default (sonnet) rates for unknown model', () => {
    const p = priceForModel('unknown-model');
    expect(p.input).toBe(3.00);
    expect(p.output).toBe(15.00);
  });
  it('returns fable rates', () => {
    const p = priceForModel('claude-fable-5');
    expect(p.input).toBe(3.00);
    expect(p.output).toBe(15.00);
  });
});

describe('lastPerSid', () => {
  it('takes last entry per sid when multiple entries exist', () => {
    const entries = [
      { sid: 'a', total_used: 100 },
      { sid: 'a', total_used: 200 },
      { sid: 'b', total_used: 50 },
    ];
    const result = lastPerSid(entries);
    const a = result.find(e => e.sid === 'a');
    expect(a.total_used).toBe(200);
    expect(result.length).toBe(2);
  });
  it('skips entries without sid', () => {
    const entries = [{ total_used: 100 }, { sid: 'a', total_used: 50 }];
    const result = lastPerSid(entries);
    expect(result.length).toBe(1);
    expect(result[0].sid).toBe('a');
  });
});

describe('normalizeEntry', () => {
  it('normalizes breakdown format', () => {
    const e = {
      sid: 'x', total_used: 1000,
      breakdown: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 700, cache_creation_input_tokens: 0 }
    };
    const n = normalizeEntry(e);
    expect(n.input_tokens).toBe(100);
    expect(n.output_tokens).toBe(200);
    expect(n.cache_read).toBe(700);
    expect(n.total).toBe(1000);
  });
  it('normalizes flat format', () => {
    const e = { sid: 'x', input_tokens: 100, output_tokens: 200, cache_read: 50, cache_creation: 10, total: 360 };
    const n = normalizeEntry(e);
    expect(n.input_tokens).toBe(100);
    expect(n.output_tokens).toBe(200);
    expect(n.total).toBe(360);
  });
});

describe('estimateCost', () => {
  it('calculates cost for 1M input + 1M output at sonnet rates', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(18.00, 4); // 3.00 + 15.00
  });
  it('calculates zero for zero tokens', () => {
    expect(estimateCost(0, 0, 'claude-sonnet-4-6')).toBe(0);
  });
  it('uses haiku rates for haiku model', () => {
    const cost = estimateCost(1_000_000, 0, 'claude-haiku-4-5-20251001');
    expect(cost).toBeCloseTo(0.80, 4);
  });
});

describe('buildRows (integration)', () => {
  let tmpDir, stateDir, runsDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cost-test-'));
    stateDir = path.join(tmpDir, 'state');
    runsDir = path.join(tmpDir, 'runs');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });

    const usage = [
      { sid: 'sid1', total_used: 100, breakdown: { input_tokens: 50, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { sid: 'sid1', total_used: 300, breakdown: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { sid: 'sid2', total_used: 50,  breakdown: { input_tokens: 10, output_tokens: 40,  cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { sid: 'sid-test', total_used: 999, breakdown: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), usage);

    fs.mkdirSync(path.join(runsDir, 'sid1'));
    fs.writeFileSync(path.join(runsDir, 'sid1', 'meta.json'), JSON.stringify({
      sid: 'sid1', agent: 'coder', created_at: '2026-01-01T00:00:00.000Z'
    }));
    fs.mkdirSync(path.join(runsDir, 'sid2'));
    fs.writeFileSync(path.join(runsDir, 'sid2', 'meta.json'), JSON.stringify({
      sid: 'sid2', agent: 'advisor', created_at: '2026-01-02T00:00:00.000Z'
    }));
    fs.mkdirSync(path.join(runsDir, 'sid-test'));
    fs.writeFileSync(path.join(runsDir, 'sid-test', 'meta.json'), JSON.stringify({
      sid: 'sid-test', agent: 'coder', isTestSession: true, created_at: '2026-01-03T00:00:00.000Z'
    }));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes isTestSession runs', () => {
    const rows = buildRows({ stateDirectory: stateDir, runsDirectory: runsDir });
    expect(rows.find(r => r.sid === 'sid-test')).toBeUndefined();
  });

  it('takes last entry per sid (100 input, not 50)', () => {
    const rows = buildRows({ stateDirectory: stateDir, runsDirectory: runsDir });
    const r = rows.find(r => r.sid === 'sid1');
    expect(r).toBeDefined();
    expect(r.input).toBe(100);
    expect(r.output).toBe(200);
  });

  it('skips sids with no meta.json', () => {
    const rows = buildRows({ stateDirectory: stateDir, runsDirectory: runsDir });
    expect(rows.length).toBe(2);
  });

  it('filters by sid', () => {
    const rows = buildRows({ stateDirectory: stateDir, runsDirectory: runsDir, sidFilter: 'sid1' });
    expect(rows.length).toBe(1);
    expect(rows[0].sid).toBe('sid1');
  });

  it('limits to lastN rows (sorted by created_at desc)', () => {
    const rows = buildRows({ stateDirectory: stateDir, runsDirectory: runsDir, lastN: 1 });
    expect(rows.length).toBe(1);
    // sid2 has newer created_at (2026-01-02)
    expect(rows[0].sid).toBe('sid2');
  });

  it('aggregates by agent', () => {
    const rows = buildRows({ stateDirectory: stateDir, runsDirectory: runsDir, byAgent: true });
    const coder = rows.find(r => r.agent === 'coder');
    expect(coder).toBeDefined();
    expect(coder.count).toBe(1); // sid-test excluded, only sid1
    const advisor = rows.find(r => r.agent === 'advisor');
    expect(advisor).toBeDefined();
    expect(advisor.count).toBe(1);
  });
});
