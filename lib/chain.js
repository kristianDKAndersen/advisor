'use strict';

const path = require('path');
const { parseFrontmatter } = require('./agents');

const AGENTS_ROOT = path.resolve(__dirname, '..', 'agents');

function resolveNextAgent(agentName, agentsRoot) {
  const root = agentsRoot || AGENTS_ROOT;
  const claudeMdPath = path.join(root, agentName, 'CLAUDE.md');
  try {
    const fm = parseFrontmatter(claudeMdPath);
    const next = fm.default_next_agent;
    if (typeof next === 'string' && next.trim() !== '') {
      return next.trim();
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { resolveNextAgent };
