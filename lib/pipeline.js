import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { readAfter } from './channel.js';

const SUMMON_BIN_PATH = path.resolve(import.meta.dir, '../bin/summon');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runPipeline(pipeline, initialContext, options = {}) {
  const { pollIntervalMs = 50, silenceTerminateMs = 600000 } = options;

  const start = Date.now();
  const steps = [];
  let prevSummary = '';

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const task = step.task_template.replace(/\{\{prev_summary\}\}/g, prevSummary);
    const goal = step.goal_template.replace(/\{\{prev_summary\}\}/g, prevSummary);

    const stdout = execFileSync(SUMMON_BIN_PATH, ['--agent', step.agent, '--task', task, '--goal', goal], { encoding: 'utf8' });
    const { sid, outbox } = JSON.parse(stdout.trim());

    const deadline = Date.now() + silenceTerminateMs;
    let resultMsg = null;
    while (Date.now() < deadline) {
      const msgs = readAfter(outbox, 0);
      resultMsg = msgs.find((m) => m.type === 'result');
      if (resultMsg) break;
      await sleep(pollIntervalMs);
    }

    let summary, paths, verdict, status;
    if (resultMsg) {
      let body = resultMsg.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) {}
      }
      summary = body?.summary;
      paths = body?.paths;
      verdict = body?.verdict;
      status = 'result';
      prevSummary = summary || '';
    } else {
      status = 'silent';
      prevSummary = '';
    }

    steps.push({ step_index: i, sid, agent: step.agent, status, summary, paths, verdict });
  }

  const end = Date.now();
  return {
    name: pipeline.name,
    steps,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
  };
}

export async function loadPipeline(taskType, repoRoot) {
  const filePath = path.join(repoRoot, 'pipelines', `${taskType}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function validatePipeline(obj) {
  if (!obj.steps || !Array.isArray(obj.steps)) {
    throw new Error('Pipeline must have a steps array');
  }
  if (!obj.name || typeof obj.name !== 'string') {
    throw new Error('Pipeline must have a name string');
  }
  if (obj.steps.length === 0) {
    throw new Error('Pipeline steps must not be empty');
  }
  for (const step of obj.steps) {
    if (!step.agent || !step.task_template || !step.goal_template) {
      throw new Error('Each step must have agent, task_template, and goal_template');
    }
  }
}
