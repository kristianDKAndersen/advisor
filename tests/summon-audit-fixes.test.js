// Regression coverage for self-audit defects #4, #11, #13 (audit-report.md) and
// audit-B.md row 17:
//   - --tier persists to session.json and is never blanked by a tier-less re-summon
//   - an invalid --tier is rejected with a usage error
//   - meta.json records the model resolved from --intelligence (was null)
//   - summon's stdout JSON no longer echoes the full task/brief text
//   - resolveIntelligence clamps out-of-range finite scores instead of throwing

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveIntelligence } from '../lib/summon.js';

const SUMMON_JS = path.resolve(import.meta.dir, '../lib/summon.js');
const TS = Date.now();
const RUNS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-audit-runs-'));
const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-audit-home-'));

afterAll(() => {
  fs.rmSync(RUNS_TMP, { recursive: true, force: true });
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
});

function provision(extraArgs, sid) {
  sid = sid || `test-audit-${TS}-${Math.random().toString(36).slice(2, 8)}`;
  const r = spawnSync(
    'node',
    [
      SUMMON_JS,
      '--agent', 'researcher',
      '--task', 'audit-fixes regression test — ignore',
      '--goal', 'test',
      '--sid', sid,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_RUNS_ROOT: RUNS_TMP, HOME: HOME_TMP },
    }
  );
  return { sid, r };
}

function sessionStateOf(sid) {
  return JSON.parse(fs.readFileSync(path.join(RUNS_TMP, sid, 'session.json'), 'utf8'));
}

function metaOf(sid) {
  return JSON.parse(fs.readFileSync(path.join(RUNS_TMP, sid, 'meta.json'), 'utf8'));
}

// --- (1) --tier persistence -------------------------------------------------

test('--tier fact persists into session.json', () => {
  const { sid, r } = provision(['--tier', 'fact']);
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  expect(sessionStateOf(sid).tier).toBe('fact');
});

test('a later summon on the same sid with no --tier does not blank an existing tier', () => {
  const { sid, r: r1 } = provision(['--tier', 'comparison']);
  if (r1.status !== 0) throw new Error(`summon exited ${r1.status}: ${r1.stderr}`);
  expect(sessionStateOf(sid).tier).toBe('comparison');

  const { r: r2 } = provision([], sid);
  if (r2.status !== 0) throw new Error(`summon exited ${r2.status}: ${r2.stderr}`);
  expect(sessionStateOf(sid).tier).toBe('comparison');
});

test('--tier fixated persists into session.json', () => {
  const { sid, r } = provision(['--tier', 'fixated']);
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  expect(sessionStateOf(sid).tier).toBe('fixated');
});

test('an invalid --tier value is rejected with a non-zero exit and a usage error', () => {
  const { r } = provision(['--tier', 'bogus']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/--tier/);
});

// --- (2) meta.json records the resolved model -------------------------------

test('meta.json records the model resolved from --intelligence 80', () => {
  const band = resolveIntelligence(80);
  const { sid, r } = provision(['--intelligence', '80']);
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  const meta = metaOf(sid);
  expect(meta.model).toBe(band.model);
  expect(meta.reasoning).toBe(band.reasoning);
});

// --- (3) stdout JSON no longer echoes the full task text --------------------

test('stdout JSON omits the full task text but meta.json keeps it', () => {
  const bigTask = 'x'.repeat(5000);
  const { sid: bigSid, r: bigR } = provision(['--task', bigTask]);
  if (bigR.status !== 0) throw new Error(`summon exited ${bigR.status}: ${bigR.stderr}`);
  const meta = JSON.parse(bigR.stdout.trim());
  expect(meta.task).toBeUndefined();
  expect(typeof meta.taskPreview).toBe('string');
  expect(meta.taskPreview.length).toBeLessThanOrEqual(120);
  expect(meta.sid).toBe(bigSid);
  expect(metaOf(bigSid).task).toBe(bigTask);

  // stdout size must not scale with the brief's size — the whole point of
  // the fix — regardless of how many bytes the tmp workspace paths cost.
  const { r: smallR } = provision(['--task', 'tiny']);
  if (smallR.status !== 0) throw new Error(`summon exited ${smallR.status}: ${smallR.stderr}`);
  expect(bigR.stdout.length - smallR.stdout.length).toBeLessThan(200);
});

// --- (4) resolveIntelligence clamps instead of throwing ----------------------

test('resolveIntelligence(107) clamps to the 100 band instead of throwing', () => {
  const upper = resolveIntelligence(100);
  const clamped = resolveIntelligence(107);
  expect(clamped.model).toBe(upper.model);
  expect(clamped.reasoning).toBe(upper.reasoning);
});

test('resolveIntelligence(-5) clamps to the 0 band instead of throwing', () => {
  const lower = resolveIntelligence(0);
  const clamped = resolveIntelligence(-5);
  expect(clamped.model).toBe(lower.model);
  expect(clamped.reasoning).toBe(lower.reasoning);
});

test('resolveIntelligence("abc") still throws RangeError (non-numeric rejected)', () => {
  expect(() => resolveIntelligence('abc')).toThrow(RangeError);
});

// --- (5) N2: meta.json records the clamped intelligence, not the raw value --

test('meta.json records the clamped intelligence (150 -> 100), not the raw out-of-range value', () => {
  const { sid, r } = provision(['--intelligence', '150']);
  if (r.status !== 0) throw new Error(`summon exited ${r.status}: ${r.stderr}`);
  const meta = metaOf(sid);
  expect(meta.intelligence).toBe(100);
});
