import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

export function readState(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
}

export function writeState(runDir, patch) {
  const stateFile = join(runDir, 'state.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (_) {}
  const updated = { ...state, ...patch, ts_updated: Math.floor(Date.now() / 1000) };
  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(updated, null, 2));
  renameSync(tmp, stateFile);
  return updated;
}

export function transitionPhase(runDir, fromPhase, toPhase) {
  const state = readState(runDir);
  if (state.phase !== fromPhase) {
    throw new Error(`Phase mismatch: expected "${fromPhase}", got "${state.phase}"`);
  }
  return writeState(runDir, { phase: toPhase });
}
