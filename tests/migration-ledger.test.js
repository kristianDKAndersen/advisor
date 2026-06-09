import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RED: these imports fail until lib/migration/ledger.js exists
import { initLedger, updateSlice, resumeSummary, territoryTableForWave } from '../lib/migration/ledger.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-ledger-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let _seq = 0;
function makeLedgerPath() {
  return path.join(tmpDir, `ledger-${++_seq}.json`);
}

function baseOpts() {
  return { migration_id: 'test-repo-20260609', source_repo: '/src', new_repo: '/new', arch_def_path: 'inline' };
}

function makeSlice(id, wave, status = 'planned', targets = [`new/src/${id}.ts`]) {
  return {
    slice_id: id, name: `Slice ${id}`, wave, status,
    depends_on: [], target_location: targets, source_refs: [],
    idiomatic_note: 'use Result<T,E>',
    equivalence_test_spec: { mode: 'B', literal_parity_approach: null, scenarios: [], test_command: '', golden_files: [], literal_gate_passed: null, idiomatic_gate_passed: null },
    coder_sid: null, commit_1_sha: null, commit_2_sha: null, failure_reason: null,
  };
}

// --- initLedger ---

test('initLedger returns object with schema_version 2', () => {
  const ledger = initLedger(baseOpts());
  expect(ledger.schema_version).toBe(2);
});

test('initLedger sets migration_id, source_repo, new_repo, arch_def_path', () => {
  const ledger = initLedger(baseOpts());
  expect(ledger.migration_id).toBe('test-repo-20260609');
  expect(ledger.source_repo).toBe('/src');
  expect(ledger.new_repo).toBe('/new');
  expect(ledger.arch_def_path).toBe('inline');
});

test('initLedger has subsystem_modes array', () => {
  const ledger = initLedger(baseOpts());
  expect(Array.isArray(ledger.subsystem_modes)).toBe(true);
});

test('initLedger has dead_code_excluded array', () => {
  const ledger = initLedger(baseOpts());
  expect(Array.isArray(ledger.dead_code_excluded)).toBe(true);
});

test('initLedger has slices array', () => {
  const ledger = initLedger(baseOpts());
  expect(Array.isArray(ledger.slices)).toBe(true);
});

test('initLedger has waves array', () => {
  const ledger = initLedger(baseOpts());
  expect(Array.isArray(ledger.waves)).toBe(true);
});

test('initLedger has equivalence_gate_confirmed_by_user false', () => {
  const ledger = initLedger(baseOpts());
  expect(ledger.equivalence_gate_confirmed_by_user).toBe(false);
});

test('initLedger has migration_complete false', () => {
  const ledger = initLedger(baseOpts());
  expect(ledger.migration_complete).toBe(false);
});

test('initLedger has total_slices 0', () => {
  const ledger = initLedger(baseOpts());
  expect(ledger.total_slices).toBe(0);
});

test('initLedger has current_wave 1', () => {
  const ledger = initLedger(baseOpts());
  expect(ledger.current_wave).toBe(1);
});

// --- updateSlice ---

test('updateSlice writes updated slice atomically', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(makeSlice('S001', 1));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  updateSlice(ledgerPath, 'S001', { status: 'literal_committed', commit_1_sha: 'abc123' });

  const updated = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  expect(updated.slices[0].status).toBe('literal_committed');
  expect(updated.slices[0].commit_1_sha).toBe('abc123');
});

test('updateSlice does not affect other slices', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(makeSlice('S001', 1));
  ledger.slices.push(makeSlice('S002', 1));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  updateSlice(ledgerPath, 'S001', { status: 'literal_committed' });

  const updated = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  expect(updated.slices[1].status).toBe('planned');
});

test('updateSlice updates ts_last_updated', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(makeSlice('S002', 1));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  updateSlice(ledgerPath, 'S002', { status: 'committed' });

  const updated = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  expect(typeof updated.ts_last_updated).toBe('string');
  expect(updated.ts_last_updated.length).toBeGreaterThan(0);
});

test('updateSlice throws for unknown slice_id', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  expect(() => updateSlice(ledgerPath, 'S999', { status: 'committed' })).toThrow(/S999/);
});

test('updateSlice writes atomically — no .tmp file left behind', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(makeSlice('S003', 1));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  updateSlice(ledgerPath, 'S003', { status: 'literal_committed' });

  expect(fs.existsSync(ledgerPath + '.tmp')).toBe(false);
});

// --- resumeSummary ---

test('resumeSummary returns status histogram and current_wave', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.current_wave = 2;
  ledger.total_slices = 3;
  ledger.slices.push(
    { ...makeSlice('S001', 1), status: 'committed' },
    { ...makeSlice('S002', 2), status: 'literal_committed' },
    { ...makeSlice('S003', 2), status: 'planned' },
  );
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const summary = resumeSummary(ledgerPath);
  expect(summary.current_wave).toBe(2);
  expect(summary.byStatus.committed).toBe(1);
  expect(summary.byStatus.literal_committed).toBe(1);
  expect(summary.byStatus.planned).toBe(1);
  expect(summary.total).toBe(3);
});

test('resumeSummary handles empty slices', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const summary = resumeSummary(ledgerPath);
  expect(summary.total).toBe(0);
  expect(typeof summary.byStatus).toBe('object');
});

// --- territoryTableForWave ---

test('territoryTableForWave emits markdown table with header', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(makeSlice('S001', 1));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const table = territoryTableForWave(ledgerPath, 1);
  expect(table).toMatch(/\|\s*Worker\s*\|/);
  expect(table).toMatch(/Files/);
});

test('territoryTableForWave includes planned slices for the wave', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(
    makeSlice('S001', 1, 'planned', ['new/src/domain/user.ts']),
    makeSlice('S002', 1, 'planned', ['new/src/domain/product.ts']),
    makeSlice('S003', 2, 'planned', ['new/src/app/service.ts']),
  );
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const table = territoryTableForWave(ledgerPath, 1);
  expect(table).toMatch(/S001/);
  expect(table).toMatch(/S002/);
  expect(table).not.toMatch(/S003/);
  expect(table).toMatch(/new\/src\/domain\/user\.ts/);
});

test('territoryTableForWave excludes non-planned slices', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  ledger.slices.push(
    { ...makeSlice('S001', 1, 'committed', ['new/src/a.ts']) },
    makeSlice('S002', 1, 'planned', ['new/src/b.ts']),
  );
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const table = territoryTableForWave(ledgerPath, 1);
  expect(table).toMatch(/S002/);
  expect(table).not.toMatch(/S001/);
});

test('territoryTableForWave returns empty table string for wave with no planned slices', () => {
  const ledgerPath = makeLedgerPath();
  const ledger = initLedger(baseOpts());
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  const table = territoryTableForWave(ledgerPath, 99);
  expect(typeof table).toBe('string');
});
