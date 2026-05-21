#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const libDir = resolve(import.meta.dir);
const agentsDir = join(libDir, '..', 'agents');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      result[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const runDir = args['run-dir'];
const runId = args['run-id'];
const rolesStr = args['teammate-roles'];

if (!runDir || !runId || !rolesStr) {
  console.log(JSON.stringify({ error: '--run-dir, --run-id, and --teammate-roles are required' }));
  process.exit(1);
}

const roles = rolesStr.split(',').map(r => r.trim()).filter(Boolean);

let delegatorTemplate, teammateTemplate;
try {
  delegatorTemplate = readFileSync(join(agentsDir, 'delegator.md'), 'utf8');
} catch (err) {
  console.log(JSON.stringify({ error: `Could not read delegator.md: ${err.message}` }));
  process.exit(1);
}
try {
  teammateTemplate = readFileSync(join(agentsDir, 'teammate.md'), 'utf8');
} catch (err) {
  console.log(JSON.stringify({ error: `Could not read teammate.md: ${err.message}` }));
  process.exit(1);
}

function substitute(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

const commonVars = { run_id: runId, run_dir: runDir, lib_dir: libDir };

const rolePrompts = {};
rolePrompts.delegator = substitute(delegatorTemplate, { ...commonVars, role: 'delegator' });
for (const role of roles) {
  rolePrompts[role] = substitute(teammateTemplate, { ...commonVars, role });
}

console.log(JSON.stringify({ role_prompts: rolePrompts }));
