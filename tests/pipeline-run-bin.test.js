import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BIN_RUN_PIPELINE = path.resolve(import.meta.dir, '../bin/run-pipeline');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-run-bin-test-'));
  const pipelinesDir = path.join(tmpDir, 'pipelines');
  fs.mkdirSync(pipelinesDir);
  fs.writeFileSync(
    path.join(pipelinesDir, 'example.json'),
    JSON.stringify({
      name: 'example',
      steps: [
        {
          agent: 'researcher',
          task_template: 'Research {{topic}}',
          goal_template: 'deliver findings',
        },
      ],
    })
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// U9-1: nonexistent task-type → exit 1 with 'no pipeline found' in stderr
test('bin/run-pipeline exits 1 with "no pipeline found" for unknown task-type', () => {
  const result = spawnSync(
    'bun',
    [BIN_RUN_PIPELINE, '--task-type', 'nonexistent', '--repo', tmpDir],
    { encoding: 'utf8' }
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no pipeline found');
});

// U9-2: --dry-run with valid pipeline fixture prints JSON report with full nested shape
test('bin/run-pipeline --dry-run prints JSON report with full nested shape', () => {
  const result = spawnSync(
    'bun',
    [BIN_RUN_PIPELINE, '--task-type', 'example', '--repo', tmpDir, '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, ADVISOR_DRY_RUN: '1' } }
  );

  let report;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch (_) {
    report = null;
  }

  expect(report).not.toBeNull();
  expect(report.name).toBe('example');
  expect(Array.isArray(report.steps)).toBe(true);
  expect(report.steps.length).toBeGreaterThanOrEqual(1);
  expect(report.steps[0].step_index).toBe(0);
  expect(typeof report.steps[0].agent).toBe('string');
});

// U9-4: --dry-run with malformed pipeline (no steps) → validation error, not TypeError (Fix #2)
test('bin/run-pipeline --dry-run exits with validation error for pipeline missing steps', () => {
  const pipelinesDir = path.join(tmpDir, 'pipelines');
  fs.writeFileSync(
    path.join(pipelinesDir, 'noSteps.json'),
    JSON.stringify({ name: 'noSteps' }) // missing steps array
  );
  const result = spawnSync(
    'bun',
    [BIN_RUN_PIPELINE, '--task-type', 'noSteps', '--repo', tmpDir, '--dry-run'],
    { encoding: 'utf8' }
  );
  expect(result.status).not.toBe(0);
  // Must be a validation error, not an unhandled TypeError
  expect(result.stderr).not.toContain('TypeError');
});
