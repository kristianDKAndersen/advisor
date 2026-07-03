import { describe, it, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { buildRows, estimateCost, priceForModel, lastPerSid, normalizeEntry, isRunSid, resolveRunSid, resolveSidArg } from '../bin/advisor-cost';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'advisor-cost');

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

describe('isRunSid', () => {
  it('matches an advisor run-sid shape', () => {
    expect(isRunSid('1783078917-04d530')).toBe(true);
  });
  it('rejects a claude session uuid', () => {
    expect(isRunSid('aaaa1111-aaaa-1111-aaaa-111111111111')).toBe(false);
  });
});

describe('resolveRunSid / resolveSidArg', () => {
  let tmpDir, stateDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cost-resolve-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'session-map.jsonl'), [
      JSON.stringify({ run_sid: '1783078917-04d530', claude_uuid: 'aaaa1111-aaaa-1111-aaaa-111111111111', agent: 'coder' }),
    ].join('\n') + '\n');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a known run-sid to its claude_uuid', () => {
    expect(resolveRunSid(stateDir, '1783078917-04d530')).toBe('aaaa1111-aaaa-1111-aaaa-111111111111');
  });

  it('returns null for an unmapped run-sid', () => {
    expect(resolveRunSid(stateDir, '9999999999-deadbe')).toBe(null);
  });

  it('resolveSidArg passes through a plain claude uuid unchanged', () => {
    const { sidFilter, error } = resolveSidArg(stateDir, 'aaaa1111-aaaa-1111-aaaa-111111111111');
    expect(sidFilter).toBe('aaaa1111-aaaa-1111-aaaa-111111111111');
    expect(error).toBe(null);
  });

  it('resolveSidArg resolves a run-sid via session-map', () => {
    const { sidFilter, error } = resolveSidArg(stateDir, '1783078917-04d530');
    expect(sidFilter).toBe('aaaa1111-aaaa-1111-aaaa-111111111111');
    expect(error).toBe(null);
  });

  it('resolveSidArg returns an error for an unmapped run-sid', () => {
    const { sidFilter, error } = resolveSidArg(stateDir, '9999999999-deadbe');
    expect(sidFilter).toBe(null);
    expect(error).toMatch(/unknown or unmapped/i);
  });
});

describe('CLI: positional sid + --sid resolution (bug fix)', () => {
  const SID_A = 'aaaa1111-aaaa-1111-aaaa-111111111111';
  const SID_B = 'bbbb2222-bbbb-2222-bbbb-222222222222';
  const RUN_SID_A = '1783078917-04d530';
  const RUN_SID_B = '1783079000-1a2b3c';
  const UNKNOWN_RUN_SID = '9999999999-deadbe';
  const UNKNOWN_UUID = 'cccc3333-cccc-3333-cccc-333333333333';

  let stateDir;

  beforeAll(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cost-cli-test-'));

    const tokenUsage = [
      { sid: SID_A, input_tokens: 600000000, output_tokens: 100, cache_read: 0, cache_creation: 0, total: 600000100, ts: 1 },
      { sid: SID_B, input_tokens: 650000000, output_tokens: 200, cache_read: 0, cache_creation: 0, total: 650000200, ts: 2 },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'token-usage.jsonl'),
      tokenUsage.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    const sessionMap = [
      { run_sid: RUN_SID_A, claude_uuid: SID_A, agent: 'coder' },
      { run_sid: RUN_SID_B, claude_uuid: SID_B, agent: 'researcher' },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'session-map.jsonl'),
      sessionMap.map(e => JSON.stringify(e)).join('\n') + '\n'
    );
  });

  afterAll(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function run(args = []) {
    return spawnSync('bun', [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_STATE_DIR: stateDir },
      timeout: 15000,
    });
  }

  test('T1: positional run-sid resolves via session-map and filters to that session only', () => {
    const r = run([RUN_SID_A]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SID_A);
    expect(r.stdout).not.toContain(SID_B);
  });

  test('T2: --sid flag with run-sid form also resolves through session-map', () => {
    const r = run(['--sid', RUN_SID_B]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SID_B);
    expect(r.stdout).not.toContain(SID_A);
  });

  test('T3: positional plain claude uuid still filters directly (no session-map hop)', () => {
    const r = run([SID_A]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SID_A);
    expect(r.stdout).not.toContain(SID_B);
  });

  test('T4: unknown/unmapped run-sid exits 1 with stderr error, no fallback to machine-wide total', () => {
    const r = run([UNKNOWN_RUN_SID]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown or unmapped/i);
    expect(r.stdout).not.toContain(SID_A);
    expect(r.stdout).not.toContain(SID_B);
  });

  test('T5: unknown claude uuid (no matching rows) exits 1 with stderr error', () => {
    const r = run([UNKNOWN_UUID]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no usage found/i);
  });

  test('T6: TOTAL row keeps large numeric columns separated, not run together', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    const totalLine = r.stdout.split('\n').find(l => l.startsWith('TOTAL'));
    expect(totalLine).toBeDefined();
    const numbers = totalLine.match(/[\d,]+/g);
    // input totals to 1,250,000,000 (13 chars, wider than the 12-char column) and
    // output totals to 300 — they must appear as distinct tokens, not merged
    // into a single garbled run like "1,250,000,00300".
    expect(numbers).toContain('1,250,000,000');
    expect(numbers).toContain('300');
  });
});
