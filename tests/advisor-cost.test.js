import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildRows, estimateCost, priceForModel, lastPerSid, normalizeEntry } from '../bin/advisor-cost';

describe('priceForModel', () => {
  it('returns haiku rates including cache rates', () => {
    const p = priceForModel('claude-haiku-4-5-20251001');
    expect(p.input).toBe(0.80);
    expect(p.output).toBe(4.00);
    expect(p.cache_read).toBe(0.08);
    expect(p.cache_creation).toBe(1.00);
  });
  it('returns sonnet rates including cache rates', () => {
    const p = priceForModel('claude-sonnet-4-6');
    expect(p.input).toBe(3.00);
    expect(p.output).toBe(15.00);
    expect(p.cache_read).toBe(0.30);
    expect(p.cache_creation).toBe(3.75);
  });
  it('returns opus rates including cache rates', () => {
    const p = priceForModel('claude-opus-4-8');
    expect(p.input).toBe(15.00);
    expect(p.output).toBe(75.00);
    expect(p.cache_read).toBe(1.50);
    expect(p.cache_creation).toBe(18.75);
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
  it('preserves last-seen order: sid re-appearing later moves to end', () => {
    const entries = [
      { sid: 'a', total_used: 1 },
      { sid: 'b', total_used: 2 },
      { sid: 'a', total_used: 3 },
    ];
    const result = lastPerSid(entries);
    expect(result[0].sid).toBe('b');
    expect(result[1].sid).toBe('a');
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

describe('estimateCost (cache-aware)', () => {
  it('calculates cost for 1M input + 1M output at sonnet rates', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(18.00, 4);
  });
  it('calculates zero for zero tokens', () => {
    expect(estimateCost(0, 0, 0, 0, 'claude-sonnet-4-6')).toBe(0);
  });
  it('uses haiku rates for haiku model', () => {
    const cost = estimateCost(1_000_000, 0, 0, 0, 'claude-haiku-4-5-20251001');
    expect(cost).toBeCloseTo(0.80, 4);
  });
  it('includes cache_read in cost at discounted rate (sonnet: $0.30/MTok)', () => {
    const cost = estimateCost(0, 0, 1_000_000, 0, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.30, 4);
  });
  it('includes cache_creation in cost at premium rate (sonnet: $3.75/MTok)', () => {
    const cost = estimateCost(0, 0, 0, 1_000_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(3.75, 4);
  });
});

describe('buildRows (integration)', () => {
  let tmpDir, stateDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cost-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const usage = [
      { sid: 'sid1', total_used: 100, breakdown: { input_tokens: 50, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { sid: 'sid1', total_used: 300, breakdown: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { sid: 'sid2', total_used: 50,  breakdown: { input_tokens: 10, output_tokens: 40,  cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { sid: 'sid-test', total_used: 999, breakdown: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), usage);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns {rows, noMap} shape', () => {
    const result = buildRows({ stateDirectory: stateDir });
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('noMap');
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('includes ALL sids — no meta.json filtering', () => {
    const { rows } = buildRows({ stateDirectory: stateDir });
    expect(rows.length).toBe(3);
    expect(rows.find(r => r.sid === 'sid-test')).toBeDefined();
  });

  it('takes last entry per sid (100 input, not 50)', () => {
    const { rows } = buildRows({ stateDirectory: stateDir });
    const r = rows.find(r => r.sid === 'sid1');
    expect(r).toBeDefined();
    expect(r.input).toBe(100);
    expect(r.output).toBe(200);
  });

  it('filters by sid', () => {
    const { rows } = buildRows({ stateDirectory: stateDir, sidFilter: 'sid1' });
    expect(rows.length).toBe(1);
    expect(rows[0].sid).toBe('sid1');
  });

  it('limits to lastN rows by file order (sid-test is last in file)', () => {
    const { rows } = buildRows({ stateDirectory: stateDir, lastN: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0].sid).toBe('sid-test');
  });

  it('returns noMap=true when byAgent but no session-map.jsonl', () => {
    const result = buildRows({ stateDirectory: stateDir, byAgent: true });
    expect(result.noMap).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('aggregates by agent when session-map.jsonl present', () => {
    const mapPath = path.join(stateDir, 'session-map.jsonl');
    fs.writeFileSync(mapPath, [
      JSON.stringify({ run_sid: 'run1', claude_uuid: 'sid1', agent: 'coder' }),
      JSON.stringify({ run_sid: 'run2', claude_uuid: 'sid2', agent: 'advisor' }),
    ].join('\n') + '\n');

    const result = buildRows({ stateDirectory: stateDir, byAgent: true });
    expect(result.noMap).toBe(false);
    const coder = result.rows.find(r => r.agent === 'coder');
    expect(coder).toBeDefined();
    expect(coder.count).toBe(1);
    const advisor = result.rows.find(r => r.agent === 'advisor');
    expect(advisor).toBeDefined();
    expect(advisor.count).toBe(1);

    fs.unlinkSync(mapPath);
  });
});
