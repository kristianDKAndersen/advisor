import { describe, it, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { buildRows, estimateCost, priceForModel, lastPerSid, normalizeEntry, isRunSid, resolveRunSid, resolveSidArg } from '../bin/advisor-cost';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'advisor-cost');

describe('priceForModel', () => {
  it('returns haiku rates including cache rates (date-suffixed id resolves)', () => {
    const p = priceForModel('claude-haiku-4-5-20251001');
    expect(p.input).toBe(1);
    expect(p.output).toBe(5);
    expect(p.cache_read).toBe(0.10);
    expect(p.cache_creation).toBe(1.25); // 5m write rate (back-compat field)
    expect(p.cache_write_1h).toBe(2);
    expect(p.known).toBe(true);
  });
  it('returns sonnet-4-6 rates including cache rates', () => {
    const p = priceForModel('claude-sonnet-4-6');
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
    expect(p.cache_read).toBe(0.30);
    expect(p.cache_creation).toBe(3.75);
    expect(p.cache_write_1h).toBe(6);
  });
  it('returns opus-4-8 rates including cache rates', () => {
    const p = priceForModel('claude-opus-4-8');
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
    expect(p.cache_read).toBe(0.50);
    expect(p.cache_creation).toBe(6.25);
    expect(p.cache_write_1h).toBe(10);
  });
  it('flags an unknown model and prices it at the sonnet-5 row', () => {
    const p = priceForModel('unknown-model');
    expect(p.input).toBe(2);
    expect(p.output).toBe(10);
    expect(p.known).toBe(false);
  });
  it('returns fable-5 rates', () => {
    const p = priceForModel('claude-fable-5');
    expect(p.input).toBe(10);
    expect(p.output).toBe(50);
    expect(p.cache_read).toBe(1);
  });
  it('longest-prefix match: claude-opus-5-5 resolves to its own row, not claude-opus-5', () => {
    const p = priceForModel('claude-opus-5-5');
    expect(p.input).toBe(4);
    expect(p.cache_read).toBe(0.20);
    expect(p.known).toBe(true);
  });
  it('longest-prefix match: claude-fable-5-1 resolves to its own row, not claude-fable-5', () => {
    const p = priceForModel('claude-fable-5-1');
    expect(p.input).toBe(10);
    expect(p.cache_read).toBe(0.25);
    expect(p.known).toBe(true);
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
  it('calculates cost for 1M input + 1M output at sonnet-4-6 rates', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(18.00, 4);
  });
  it('calculates zero for zero tokens', () => {
    expect(estimateCost(0, 0, 0, 0, 'claude-sonnet-4-6')).toBe(0);
  });
  it('uses haiku-4-5 rates for haiku model', () => {
    const cost = estimateCost(1_000_000, 0, 0, 0, 'claude-haiku-4-5-20251001');
    expect(cost).toBeCloseTo(1.00, 4);
  });
  it('includes cache_read in cost at discounted rate (sonnet-4-6: $0.30/MTok)', () => {
    const cost = estimateCost(0, 0, 1_000_000, 0, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.30, 4);
  });
  it('includes cache_creation (5m write) in cost at the 5m rate (sonnet-4-6: $3.75/MTok)', () => {
    const cost = estimateCost(0, 0, 0, 1_000_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(3.75, 4);
  });
});

describe('priceForModel: 5m vs 1h cache write', () => {
  it('sonnet-4-6: 1M 5m-write tokens cost 3.75, 1M 1h-write tokens cost 6.00', () => {
    const p = priceForModel('claude-sonnet-4-6');
    expect((1_000_000 / 1_000_000) * p.cache_creation).toBeCloseTo(3.75, 4);
    expect((1_000_000 / 1_000_000) * p.cache_write_1h).toBeCloseTo(6.00, 4);
  });
});

describe('v2 row pricing (by_model, two models, exact dollar math)', () => {
  it('prices a v2 row by summing per-model costs from by_model', () => {
    const row = {
      sid: 'v2-two-model',
      counting: 'dedupe-v2',
      total_used: 4_000_000,
      breakdown: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 },
      by_model: {
        'claude-opus-4-8': {
          input_tokens: 1_000_000, output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_5m_input_tokens: 1_000_000,
          cache_creation_1h_input_tokens: 1_000_000,
        },
        'claude-haiku-4-5-20251001': {
          input_tokens: 1_000_000, output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_5m_input_tokens: 1_000_000,
          cache_creation_1h_input_tokens: 1_000_000,
        },
      },
    };
    const n = normalizeEntry(row);
    // opus-4-8: 5 + 25 + 0.50 + 6.25 + 10 = 46.75
    // haiku-4-5: 1 + 5 + 0.10 + 1.25 + 2 = 9.35
    expect(n.cost).toBeCloseTo(56.10, 6);
    expect(n.legacy).toBe(false);
  });

  it('flags an unknown model inside by_model and prices it at the sonnet-5 row', () => {
    const row = {
      sid: 'v2-unpriced',
      counting: 'dedupe-v2',
      total_used: 1_000_000,
      breakdown: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      by_model: {
        'claude-foo-9': { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_5m_input_tokens: 0, cache_creation_1h_input_tokens: 0 },
      },
    };
    const n = normalizeEntry(row);
    expect(n.cost).toBeCloseTo(2.00, 4); // sonnet-5 input rate
    expect(n.unpriced).toEqual(['claude-foo-9']);
  });
});

describe('legacy row pricing (no counting:dedupe-v2)', () => {
  it('still reads and prices a legacy row, marked legacy, without adjusting token counts', () => {
    const row = {
      sid: 'legacy-1', total_used: 2_000_000,
      breakdown: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const n = normalizeEntry(row);
    expect(n.legacy).toBe(true);
    expect(n.input_tokens).toBe(1_000_000);
    expect(n.output_tokens).toBe(1_000_000);
    // Legacy rows carry no model: priced at the same default (sonnet-4-6 @ 5m
    // write rate) today's code already used, so historical $ figures don't move.
    expect(n.cost).toBeCloseTo(18.00, 4);
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

describe('CLI: unpriced model flag surfaces in stdout', () => {
  let stateDir;

  beforeAll(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cost-unpriced-test-'));
    const row = {
      sid: 'unpriced-sid', counting: 'dedupe-v2', total_used: 1_000_000,
      breakdown: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      by_model: { 'claude-foo-9': { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_5m_input_tokens: 0, cache_creation_1h_input_tokens: 0 } },
    };
    fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), JSON.stringify(row) + '\n');
  });

  afterAll(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('prints unpriced:<model> rather than silently defaulting', () => {
    const r = spawnSync('bun', [BIN], { encoding: 'utf8', env: { ...process.env, ADVISOR_STATE_DIR: stateDir }, timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('unpriced:claude-foo-9');
  });
});

describe('CLI: live cost for an unaccrued sid (never synthesized)', () => {
  const CLAUDE_UUID = 'dddd4444-dddd-4444-dddd-444444444444';
  const RUN_SID = '1790000000-11ea00';
  const NO_TRANSCRIPT_RUN_SID = '1790000001-a0a001';
  const NO_TRANSCRIPT_UUID = 'eeee5555-eeee-5555-eeee-555555555555';

  let stateDir, runsRoot, projectsDir, workspace, tokenUsagePath;

  function makeTranscript(uuid, usages) {
    return usages.map(u => JSON.stringify({ message: { role: 'assistant', usage: u } })).join('\n') + '\n';
  }
  function encodeProjectDir(p) { return p.replace(/[/.]/g, '-'); }

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cost-live-test-'));
    stateDir = path.join(tmpDir, 'state');
    runsRoot = path.join(tmpDir, 'runs');
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(stateDir, { recursive: true });

    workspace = path.join(runsRoot, RUN_SID, 'workspace');
    fs.mkdirSync(path.join(runsRoot, RUN_SID), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, RUN_SID, 'meta.json'), JSON.stringify({ workspace }));
    const projDir = path.join(projectsDir, encodeProjectDir(workspace));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${CLAUDE_UUID}.jsonl`), makeTranscript(CLAUDE_UUID, [
      { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ]));

    // Mapped run_sid whose meta.json workspace exists but transcript file does not.
    const noTxWorkspace = path.join(runsRoot, NO_TRANSCRIPT_RUN_SID, 'workspace');
    fs.mkdirSync(path.join(runsRoot, NO_TRANSCRIPT_RUN_SID), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, NO_TRANSCRIPT_RUN_SID, 'meta.json'), JSON.stringify({ workspace: noTxWorkspace }));

    fs.writeFileSync(path.join(stateDir, 'session-map.jsonl'), [
      { run_sid: RUN_SID, claude_uuid: CLAUDE_UUID, agent: 'coder' },
      { run_sid: NO_TRANSCRIPT_RUN_SID, claude_uuid: NO_TRANSCRIPT_UUID, agent: 'coder' },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');

    // No token-usage.jsonl at all — both sids are unaccrued.
    tokenUsagePath = path.join(stateDir, 'token-usage.jsonl');
  });

  afterAll(() => {
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync('bun', [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_STATE_DIR: stateDir, ADVISOR_RUNS_ROOT: runsRoot, ADVISOR_CLAUDE_PROJECTS_DIR: projectsDir },
      timeout: 15000,
    });
  }

  test('computes cost live for an unaccrued sid and marks it not-yet-accrued', () => {
    const before = fs.existsSync(tokenUsagePath) ? { size: fs.statSync(tokenUsagePath).size } : null;

    const r = run(['--sid', RUN_SID]);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(RUN_SID); // SID column shows the run sid, not the claude uuid
    expect(r.stdout).toContain(CLAUDE_UUID); // uuid still noted, secondarily
    expect(r.stdout).toMatch(/live, not yet accrued/);
    expect(r.stdout).toContain(`advisor-cost-backfill --sid ${RUN_SID}`); // concrete sid in hint, not '<run-sid>'
    expect(r.stdout).toContain('1,000'); // input tokens
    expect(r.stdout).toContain('500');   // output tokens

    const sidLine = r.stdout.split('\n').find(l => l.startsWith(RUN_SID));
    expect(sidLine).toBeDefined();

    const after = fs.existsSync(tokenUsagePath) ? { size: fs.statSync(tokenUsagePath).size } : null;
    expect(after).toEqual(before); // advisor-cost never writes token-usage.jsonl
  });

  test('mtime of token-usage.jsonl (when present) is unchanged by a live lookup', () => {
    fs.writeFileSync(tokenUsagePath, JSON.stringify({ sid: 'unrelated', total_used: 1 }) + '\n');
    const before = fs.statSync(tokenUsagePath);

    const r = run(['--sid', RUN_SID]);
    expect(r.status).toBe(0);

    const after = fs.statSync(tokenUsagePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    fs.rmSync(tokenUsagePath);
  });

  test('prints an explicit no-telemetry message when the transcript file is missing', () => {
    const r = run(['--sid', NO_TRANSCRIPT_RUN_SID]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no telemetry found for/i);
  });
});
