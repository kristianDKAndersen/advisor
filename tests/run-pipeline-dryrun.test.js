import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BIN_RUN_PIPELINE = path.resolve(import.meta.dir, '../bin/run-pipeline');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-dryrun-test-'));
  const pipelinesDir = path.join(tmpDir, 'pipelines');
  fs.mkdirSync(pipelinesDir);

  // Valid pipeline for positive test
  fs.writeFileSync(
    path.join(pipelinesDir, 'valid.json'),
    JSON.stringify({
      name: 'valid-pipeline',
      steps: [
        {
          agent: 'researcher',
          task_template: 'Research {{prev_summary}}',
          goal_template: 'deliver findings',
        },
      ],
    })
  );

  // Malformed pipeline: missing steps
  fs.writeFileSync(
    path.join(pipelinesDir, 'no-steps.json'),
    JSON.stringify({
      name: 'malformed-pipeline',
    })
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// RED: --dry-run on pipeline with missing steps must fail validation, not throw TypeError
test('bin/run-pipeline --dry-run rejects pipeline missing steps (validation error, not TypeError)', () => {
  const result = spawnSync(
    'bun',
    [BIN_RUN_PIPELINE, '--task-type', 'no-steps', '--repo', tmpDir, '--dry-run'],
    { encoding: 'utf8' }
  );

  // Expect non-zero exit
  expect(result.status).not.toBe(0);

  // Expect validation error message in stderr, not a TypeError
  expect(result.stderr).toContain('Pipeline must have a steps array');
  expect(result.stderr).not.toContain('TypeError');
});

// GREEN: --dry-run on valid pipeline must succeed
test('bin/run-pipeline --dry-run succeeds on valid pipeline', () => {
  const result = spawnSync(
    'bun',
    [BIN_RUN_PIPELINE, '--task-type', 'valid', '--repo', tmpDir, '--dry-run'],
    { encoding: 'utf8' }
  );

  expect(result.status).toBe(0);

  let report;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch (_) {
    report = null;
  }

  expect(report).not.toBeNull();
  expect(report.name).toBe('valid-pipeline');
  expect(Array.isArray(report.steps)).toBe(true);
  expect(report.steps.length).toBeGreaterThanOrEqual(1);
});
