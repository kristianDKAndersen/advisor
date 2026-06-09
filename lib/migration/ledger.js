'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Initialize a new slice ledger with schema_version 2.
 * Returns the ledger object (does NOT write to disk — caller writes it).
 */
function initLedger({ migration_id, source_repo, new_repo, arch_def_path }) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    migration_id,
    source_repo,
    new_repo,
    arch_def_path,
    subsystem_modes: [],
    equivalence_gate_confirmed_by_user: false,
    total_slices: 0,
    waves: [],
    slices: [],
    dead_code_excluded: [],
    ts_started: now,
    ts_last_updated: now,
    current_wave: 1,
    migration_complete: false,
  };
}

/**
 * Atomically update a slice in the ledger at ledgerPath.
 * Throws if slice_id is not found.
 */
function updateSlice(ledgerPath, sliceId, updates) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const slice = ledger.slices.find(s => s.slice_id === sliceId);
  if (!slice) throw new Error(`slice_id not found: ${sliceId}`);
  Object.assign(slice, updates);
  ledger.ts_last_updated = new Date().toISOString();
  const tmpPath = ledgerPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmpPath, ledgerPath);
}

/**
 * Return a summary object with status histogram and current_wave.
 */
function resumeSummary(ledgerPath) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const byStatus = ledger.slices.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  return {
    current_wave: ledger.current_wave,
    byStatus,
    total: ledger.slices.length,
  };
}

/**
 * Emit the wave territory markdown table consumed by validate-territory.sh.
 * Only includes slices with status === 'planned' for the given wave number.
 */
function territoryTableForWave(ledgerPath, waveNumber) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const waveSlices = ledger.slices.filter(s => s.wave === waveNumber && s.status === 'planned');
  let table = '| Worker | Files (no overlap with other rows) | Fix IDs |\n';
  table += '|---|---|---|\n';
  for (const s of waveSlices) {
    const files = Array.isArray(s.target_location) ? s.target_location.join(', ') : String(s.target_location);
    table += `| coder-${s.slice_id} | ${files} | ${s.slice_id} |\n`;
  }
  return table;
}

module.exports = { initLedger, updateSlice, resumeSummary, territoryTableForWave };
