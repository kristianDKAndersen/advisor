'use strict';

const { test, expect } = require('bun:test');
const os = require('os');
const { composeBootstrapPrompt, composeTaskBody } = require('../lib/summon');

// R2 prefix stability: the discovery scaffolding is task-varying, so it lives
// in the inbox task body (composeTaskBody), never in the bootstrap prompt.

const baseArgs = {
  sid: 'test-' + Date.now(),
  agentName: 'coder',
  workspace: os.tmpdir(),
  channelDir: os.tmpdir(),
  outputDir: os.tmpdir(),
  advisorRoot: os.tmpdir(),
  repo: os.tmpdir(),
  outputReason: 'cwd-fallback',
  goal: 'test goal',
};

const taskArgs = { sid: 'test-' + Date.now(), task: 'test task', goal: 'test goal' };

test('composeTaskBody with discoveryHint:true includes DISCOVERY_SCAFFOLDING marker', () => {
  const out = composeTaskBody({ ...taskArgs, discoveryHint: true });
  expect(out).toContain('[DISCOVERY_SCAFFOLDING]');
});

test('composeTaskBody with discoveryHint:false does NOT include DISCOVERY_SCAFFOLDING marker', () => {
  const out = composeTaskBody({ ...taskArgs, discoveryHint: false });
  expect(out).not.toContain('[DISCOVERY_SCAFFOLDING]');
});

test('composeTaskBody without discoveryHint does NOT include DISCOVERY_SCAFFOLDING marker', () => {
  const out = composeTaskBody({ ...taskArgs });
  expect(out).not.toContain('[DISCOVERY_SCAFFOLDING]');
});

test('composeBootstrapPrompt NEVER includes DISCOVERY_SCAFFOLDING marker (even with discoveryHint:true)', () => {
  const out = composeBootstrapPrompt({ ...baseArgs, discoveryHint: true });
  expect(out).not.toContain('[DISCOVERY_SCAFFOLDING]');
});
