#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const TASK_DEADLINE_SECS = 120;

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

if (!runDir) {
  console.log(JSON.stringify({ error: '--run-dir is required' }));
  process.exit(1);
}

const taskListPath = join(runDir, 'task-list.json');
const stateFile = join(runDir, 'state.json');
const lockDir = join(runDir, '.task-claim.lock');

function reclaimSweep() {
  const deadline = Date.now() + 5000;
  const now = Math.floor(Date.now() / 1000);

  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        const list = JSON.parse(readFileSync(taskListPath, 'utf8'));
        let state = { done_roles: [], stalls: [] };
        try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (_) {}

        // Derive done-roles from signals/ files — the authoritative source.
        // state.json.done_roles is an observability mirror only; reclaim never trusts it.
        const signalsDir = join(runDir, 'signals');
        const doneRoles = existsSync(signalsDir)
          ? readdirSync(signalsDir).filter(f => f.startsWith('done.')).map(f => f.slice(5))
          : [];

        const reclaimed = [];
        const unassignedOrphans = [];
        const livenessTimeouts = [];
        const newStalls = [];

        for (const task of list.tasks) {
          if (
            task.status === 'in_progress' &&
            task.claimed_at != null &&
            (now - task.claimed_at) > TASK_DEADLINE_SECS
          ) {
            newStalls.push({ task_id: task.id, prior_claimed_by: task.claimed_by, ts: now });
            task.status = 'pending';
            task.claimed_by = null;
            task.claimed_at = null;
            task.assigned_teammate = null;
            reclaimed.push(task.id);
          }
        }

        for (const task of list.tasks) {
          if (
            task.status === 'pending' &&
            task.assigned_teammate != null &&
            doneRoles.includes(task.assigned_teammate)
          ) {
            newStalls.push({ task_id: task.id, prior_claimed_by: task.assigned_teammate, ts: now });
            task.assigned_teammate = null;
            unassignedOrphans.push(task.id);
          }
        }

        // Branch 3: never-claimed-by-assignee liveness timeout.
        // Fires when the assigned teammate never claimed the task and the run has exceeded the deadline.
        if (state.ts_started != null && (now - state.ts_started) > TASK_DEADLINE_SECS) {
          for (const task of list.tasks) {
            const neverClaimed = task.claim_history
              ? task.claim_history.length === 0
              : (task.claimed_at == null && task.claimed_by == null);
            if (
              task.status === 'pending' &&
              task.assigned_teammate != null &&
              !doneRoles.includes(task.assigned_teammate) &&
              neverClaimed
            ) {
              newStalls.push({ task_id: task.id, prior_claimed_by: task.assigned_teammate, ts: now });
              task.assigned_teammate = null;
              livenessTimeouts.push(task.id);
            }
          }
        }

        const tmp = taskListPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(list, null, 2));
        renameSync(tmp, taskListPath);

        const prevDoneKey = (state.done_roles || []).slice().sort().join(',');
        const nextDoneKey = doneRoles.slice().sort().join(',');
        if (newStalls.length > 0 || prevDoneKey !== nextDoneKey) {
          const stalls = (state.stalls || []).concat(newStalls);
          const updatedState = { ...state, done_roles: doneRoles, stalls, ts_updated: now };
          const stateTmp = stateFile + '.tmp';
          writeFileSync(stateTmp, JSON.stringify(updatedState, null, 2));
          renameSync(stateTmp, stateFile);
        }

        return { reclaimed, unassigned_orphans: unassignedOrphans, liveness_timeouts: livenessTimeouts };
      } finally {
        rmdirSync(lockDir);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error('reclaim: lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

try {
  const result = reclaimSweep();
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
