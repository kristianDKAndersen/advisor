'use strict';

// P1 role-conditional filtering for ECO-CORE (see lib/eco-rules.js
// getEcoCoreBlock). Coder-family and unmatched/unknown agents keep the full
// ECO_CORE_BLOCK (fail-open); research-family agents get a fetch/citation
// Tools variant instead of the Edit/Grep-specific one.

const { test, expect } = require('bun:test');
const {
  ECO_CORE_BLOCK,
  ECO_REVIEW_BLOCK,
  ECO_REVIEW_AGENTS,
  getEcoCoreBlock,
} = require('../lib/eco-rules');
const { composeBootstrapPrompt } = require('../lib/summon');

const CODER_ONLY = 'one-fix-at-a-time TDD pairing';
const RESEARCH_ONLY = 'WebSearch/WebFetch';

function argsFor(sid, agentName) {
  return {
    sid,
    agentName,
    workspace: '/tmp/ws-' + sid,
    channelDir: '/tmp/chan-' + sid,
    outputDir: '/tmp/out-' + sid,
    advisorRoot: '/tmp/adv-' + sid,
    repo: '/tmp/repo-' + sid,
    goal: 'eco role filter test goal ' + sid,
  };
}

test('coder block omits a research-only passage present in the researcher block', () => {
  const coderBlock = getEcoCoreBlock('coder');
  const researcherBlock = getEcoCoreBlock('researcher');
  expect(researcherBlock).toContain(RESEARCH_ONLY);
  expect(coderBlock).not.toContain(RESEARCH_ONLY);
});

test('researcher block omits a coder-only passage present in the coder block', () => {
  const coderBlock = getEcoCoreBlock('coder');
  const researcherBlock = getEcoCoreBlock('researcher');
  expect(coderBlock).toContain(CODER_ONLY);
  expect(researcherBlock).not.toContain(CODER_ONLY);
});

test('unknown agent name receives the full ECO_CORE_BLOCK (fail-open)', () => {
  expect(getEcoCoreBlock('some-brand-new-agent-nobody-registered')).toBe(ECO_CORE_BLOCK);
  expect(getEcoCoreBlock(undefined)).toBe(ECO_CORE_BLOCK);
});

test('coder family still gets exactly ECO_CORE_BLOCK (existing contract preserved)', () => {
  expect(getEcoCoreBlock('coder')).toBe(ECO_CORE_BLOCK);
});

test('ECO-REVIEW routing unchanged: review agent map and block untouched', () => {
  expect(ECO_REVIEW_AGENTS.has('code-reviewer')).toBe(true);
  expect(ECO_REVIEW_AGENTS.has('evaluator')).toBe(true);
  expect(ECO_REVIEW_AGENTS.has('tournament-evaluator')).toBe(true);
  expect(ECO_REVIEW_AGENTS.has('fact-checker')).toBe(true);
  expect(ECO_REVIEW_BLOCK).toContain('## ECO-REVIEW');
});

test('ADVISOR_ECO=0 path unchanged: composeBootstrapPrompt still gates on the env var', () => {
  const prevEco = process.env.ADVISOR_ECO;
  process.env.ADVISOR_ECO = '0';
  try {
    const out = composeBootstrapPrompt(argsFor('1700000006-fffff6', 'researcher'));
    expect(out).not.toContain('## ECO-CORE');
    expect(out).not.toContain('## ECO-REVIEW');
  } finally {
    if (prevEco === undefined) delete process.env.ADVISOR_ECO;
    else process.env.ADVISOR_ECO = prevEco;
  }
});

test('composeBootstrapPrompt routes researcher through the filtered ECO-CORE block', () => {
  const out = composeBootstrapPrompt(argsFor('1700000007-ggggg7', 'researcher'));
  expect(out).toContain(RESEARCH_ONLY);
  expect(out).not.toContain(CODER_ONLY);
});

test('composeBootstrapPrompt keeps the full ECO-CORE block for coder', () => {
  const out = composeBootstrapPrompt(argsFor('1700000008-hhhhh8', 'coder'));
  expect(out).toContain(CODER_ONLY);
  expect(out).not.toContain(RESEARCH_ONLY);
});
