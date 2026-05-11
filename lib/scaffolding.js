'use strict';

/**
 * Prompt fragment injected into a worker's bootstrap when preflight flags is_vague.
 * Must contain the [DISCOVERY_SCAFFOLDING] marker on its first line.
 */
const DISCOVERY_SCAFFOLDING = [
  '[DISCOVERY_SCAFFOLDING]',
  'Your task appears underspecified. Before proceeding:',
  '1. Identify what information is missing or ambiguous.',
  '2. State your assumptions explicitly.',
  '3. Scope your work to what can be determined with confidence.',
  '4. Flag remaining unknowns in your deliverable.',
].join('\n');

module.exports = { DISCOVERY_SCAFFOLDING };
