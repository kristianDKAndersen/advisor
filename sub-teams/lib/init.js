#!/usr/bin/env bun
import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

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
const stateStr = args['state'];
const tasksStr = args['tasks'];

if (!runDir || !stateStr || !tasksStr) {
  console.log(JSON.stringify({ error: '--run-dir, --state, and --tasks are required' }));
  process.exit(1);
}

try {
  const state = JSON.parse(stateStr);
  const tasks = JSON.parse(tasksStr);

  mkdirSync(join(runDir, 'inbox'), { recursive: true });
  mkdirSync(join(runDir, 'signals'), { recursive: true });

  const stateFile = join(runDir, 'state.json');
  const stateTmp = stateFile + '.tmp';
  writeFileSync(stateTmp, JSON.stringify(state, null, 2));
  renameSync(stateTmp, stateFile);

  const taskFile = join(runDir, 'task-list.json');
  const taskTmp = taskFile + '.tmp';
  writeFileSync(taskTmp, JSON.stringify({ tasks }, null, 2));
  renameSync(taskTmp, taskFile);

  console.log(JSON.stringify({ ok: true, run_dir: runDir }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
