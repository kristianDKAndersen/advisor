'use strict';

// ECO-CORE/ECO-REVIEW injection into composeBootstrapPrompt (lib/summon.js),
// gated by ADVISOR_ECO=0. See lib/eco-rules.js for the rule text and the
// exhaustiveness-critical agent map (ECO_REVIEW_AGENTS).

const { test, expect, afterEach } = require('bun:test');
const { composeBootstrapPrompt } = require('../lib/summon');
const { ECO_CORE_BLOCK, ECO_REVIEW_BLOCK } = require('../lib/eco-rules');

afterEach(() => {
  delete process.env.ADVISOR_ECO;
});

function argsFor(agentName) {
  return {
    sid: '1700000005-eeee5',
    agentName,
    workspace: '/tmp/ws-eco',
    channelDir: '/tmp/chan-eco',
    outputDir: '/tmp/out-eco',
    advisorRoot: '/tmp/adv-eco',
    repo: '/tmp/repo-eco',
    goal: 'eco test goal',
  };
}

test('ECO-CORE present in a default agent bootstrap, ECO-REVIEW absent', () => {
  const out = composeBootstrapPrompt(argsFor('coder'));
  expect(out).toContain(ECO_CORE_BLOCK);
  expect(out).not.toContain('## ECO-REVIEW');
});

test('ECO-REVIEW present for a mapped review agent, ECO-CORE absent', () => {
  const out = composeBootstrapPrompt(argsFor('code-reviewer'));
  expect(out).toContain(ECO_REVIEW_BLOCK);
  expect(out).not.toContain('## ECO-CORE');
});

test('ADVISOR_ECO=0 yields neither ECO-CORE nor ECO-REVIEW', () => {
  process.env.ADVISOR_ECO = '0';
  const coderOut = composeBootstrapPrompt(argsFor('coder'));
  const reviewerOut = composeBootstrapPrompt(argsFor('code-reviewer'));
  expect(coderOut).not.toContain('## ECO-CORE');
  expect(coderOut).not.toContain('## ECO-REVIEW');
  expect(reviewerOut).not.toContain('## ECO-CORE');
  expect(reviewerOut).not.toContain('## ECO-REVIEW');
});

test('existing bootstrap content (channel instructions, vault recall pointer) unaffected', () => {
  const out = composeBootstrapPrompt(argsFor('coder'));
  expect(out).toContain('## Channel — how you talk to the Advisor');
  expect(out).toContain('$INBOX');
  expect(out).toContain('$OUTBOX');
  expect(out).toMatch(/inbox seq 1[^\n]*goal/i);
  const withoutEco = composeBootstrapPrompt({ ...argsFor('coder'), agentName: 'coder' });
  expect(withoutEco).toContain('Your project-level CLAUDE.md');
});
