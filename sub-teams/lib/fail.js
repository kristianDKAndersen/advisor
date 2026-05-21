#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync } from 'fs';
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
const taskId = args['task-id'];
const errorMsg = args['error'];

if (!runDir || !taskId || errorMsg === undefined) {
  console.log(JSON.stringify({ error: '--run-dir, --task-id, and --error are required' }));
  process.exit(1);
}

const taskListPath = join(runDir, 'task-list.json');
const lockDir = join(runDir, '.task-claim.lock');

function failTask() {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        const list = JSON.parse(readFileSync(taskListPath, 'utf8'));
        const task = list.tasks.find(t => t.id === taskId);
        if (!task) throw Object.assign(new Error(`Task ${taskId} not found`), { notFound: true });
        task.status = 'failed';
        task.error = errorMsg;
        task.completed_at = Math.floor(Date.now() / 1000);
        const tmp = taskListPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(list, null, 2));
        renameSync(tmp, taskListPath);
        return { ok: true };
      } finally {
        rmdirSync(lockDir);
      }
    } catch (err) {
      if (err.notFound) throw err;
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error('fail: lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

try {
  const result = failTask();
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
