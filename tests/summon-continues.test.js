import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';

// bun test runs the whole suite in one process, so lib/session's RUNS_ROOT
// (captured from ADVISOR_RUNS_ROOT at first require, possibly by an earlier
// test file) is already fixed by the time this file loads. Use session's own
// path helpers to seed/locate state instead of assuming control over the
// runs root.
const session = require('../lib/session');
const { composeTaskBody } = require('../lib/summon');

const createdSids = [];

afterAll(() => {
  for (const sid of createdSids) {
    fs.rmSync(session.sessionDir(sid), { recursive: true, force: true });
  }
});

function seedPredecessor(sid) {
  createdSids.push(sid);
  const dir = session.sessionDir(sid);
  fs.mkdirSync(path.join(dir, 'channel'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({
      schema_version: 2,
      sid,
      user_prompt: '',
      tier: '',
      decomposition: [],
      decisions: [],
      next_action: 'run the migration script',
    })
  );
  fs.writeFileSync(
    path.join(dir, 'synthesis.log'),
    JSON.stringify({
      seq: 1,
      sid,
      ts: 1,
      established: 'x',
      gap: 'unclear if prod db migrated',
      material: 'yes',
      next_action: 'run the migration script',
      key_quotes: 'migration applied to staging only',
      ts_iso: 'x',
    }) + '\n'
  );
  fs.writeFileSync(
    session.outboxPath(sid),
    JSON.stringify({
      seq: 1,
      type: 'result',
      from: 'coder',
      body: { summary: 'done', paths: [], verdict: 'partial' },
    }) + '\n'
  );
}

test('composeTaskBody with --continues injects a PREDECESSOR STATE block labeled unverified', () => {
  const priorSid = `prior-continues-${Date.now()}`;
  seedPredecessor(priorSid);

  const successorSid = `successor-continues-${Date.now()}`;
  createdSids.push(successorSid);
  const body = composeTaskBody({
    sid: successorSid,
    task: 'do X',
    goal: 'X done',
    continues: priorSid,
  });

  expect(body).toContain('PREDECESSOR STATE (unverified)');
  expect(body).toContain('run the migration script');
  expect(body).toContain('unclear if prod db migrated');
  expect(body).toContain('migration applied to staging only');
  expect(body).toContain('partial');
  // Distrust framing: treat as historical notes, not ground truth.
  expect(body.toLowerCase()).toContain('not ground truth');
});

test('composeTaskBody without --continues leaves the task body unchanged (no predecessor block)', () => {
  const successorSid = `successor-no-continues-${Date.now()}`;
  createdSids.push(successorSid);
  const body = composeTaskBody({
    sid: successorSid,
    task: 'do Y',
    goal: 'Y done',
  });

  expect(body).not.toContain('PREDECESSOR STATE');
});
