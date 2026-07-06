import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Follows the ADVISOR_VAULT temp-dir fixture pattern from tests/vault.test.js.
// composeTaskBody re-requires ./vault lazily on each call, and vault.js reads
// ADVISOR_VAULT dynamically (not cached at load time), so swapping the env
// var between tests is safe even though both modules are required once.

let vault;
let tmpVaultRoot;

beforeAll(async () => {
  tmpVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-recall-test-'));
  process.env.ADVISOR_VAULT = tmpVaultRoot;
  vault = await import('../lib/vault.js');
});

afterAll(() => {
  fs.rmSync(tmpVaultRoot, { recursive: true, force: true });
  delete process.env.ADVISOR_VAULT_RECALL;
});

const { composeTaskBody } = require('../lib/summon');
const session = require('../lib/session');

const createdSids = [];
afterAll(() => {
  for (const sid of createdSids) {
    fs.rmSync(session.sessionDir(sid), { recursive: true, force: true });
  }
});

function freshSid(prefix) {
  const sid = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  createdSids.push(sid);
  return sid;
}

test('injection happens on a match: recall section appended with note name, type, snippet, path', () => {
  vault.writeSynthesisNote({
    sid: 'RECALL-MATCH-SID',
    seq: 1,
    ts: Date.now() / 1000,
    ts_iso: new Date().toISOString(),
    established: 'Migrating the payment gateway requires a staged rollout plan.',
    gap: 'none',
    material: 'no',
    next_action: 'proceed',
    key_quotes: ''
  });

  delete process.env.ADVISOR_VAULT_RECALL;
  const sid = freshSid('recall-match');
  const body = composeTaskBody({
    sid,
    task: 'Please plan the payment gateway migration rollout for the billing service.',
    goal: 'Rollout plan drafted',
  });

  expect(body).toContain('## Prior vault context (auto-recall)');
  expect(body).toContain('RECALL-MATCH-SID-1');
  expect(body).toContain('synthesis');
  expect(body).toContain(tmpVaultRoot);
});

test('silent skip on empty vault: no recall section when nothing matches', () => {
  delete process.env.ADVISOR_VAULT_RECALL;
  const sid = freshSid('recall-empty');
  const body = composeTaskBody({
    sid,
    task: 'Investigate an entirely unrelated topic about zebra migration patterns in Africa.',
    goal: 'Report on zebras',
  });

  expect(body).not.toContain('## Prior vault context (auto-recall)');
});

test('env-gate off: ADVISOR_VAULT_RECALL=0 disables recall even with a matching note', () => {
  process.env.ADVISOR_VAULT_RECALL = '0';
  try {
    const sid = freshSid('recall-gated');
    const body = composeTaskBody({
      sid,
      task: 'Please plan the payment gateway migration rollout for the billing service.',
      goal: 'Rollout plan drafted',
    });
    expect(body).not.toContain('## Prior vault context (auto-recall)');
  } finally {
    delete process.env.ADVISOR_VAULT_RECALL;
  }
});

test('malformed task text (XML/quotes/parens) does not throw', () => {
  delete process.env.ADVISOR_VAULT_RECALL;
  const sid = freshSid('recall-malformed');
  const malformed = '<task attr="value">Fix the (parser) & "quoted" <nested>bug</nested> in payment gateway</task>';
  expect(() => {
    const body = composeTaskBody({
      sid,
      task: malformed,
      goal: 'Bug fixed',
    });
    expect(typeof body).toBe('string');
  }).not.toThrow();
});
