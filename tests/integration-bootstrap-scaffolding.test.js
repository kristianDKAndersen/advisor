'use strict';

const { test, expect } = require('bun:test');
const os = require('os');
const { composeBootstrapPrompt } = require('../lib/summon');

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

test('composeBootstrapPrompt with discoveryHint:true includes DISCOVERY_SCAFFOLDING marker', () => {
  const out = composeBootstrapPrompt({ ...baseArgs, discoveryHint: true });
  expect(out).toContain('[DISCOVERY_SCAFFOLDING]');
});

test('composeBootstrapPrompt with discoveryHint:false does NOT include DISCOVERY_SCAFFOLDING marker', () => {
  const out = composeBootstrapPrompt({ ...baseArgs, discoveryHint: false });
  expect(out).not.toContain('[DISCOVERY_SCAFFOLDING]');
});

test('composeBootstrapPrompt without discoveryHint does NOT include DISCOVERY_SCAFFOLDING marker', () => {
  const out = composeBootstrapPrompt({ ...baseArgs });
  expect(out).not.toContain('[DISCOVERY_SCAFFOLDING]');
});
