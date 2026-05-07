import { test, expect, beforeAll, afterAll } from 'bun:test';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { loadPipeline, validatePipeline } from '../lib/pipeline.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-load-test-'));
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

test('loadPipeline is a named export', () => {
  expect(typeof loadPipeline).toBe('function');
});

test('loadPipeline returns null for nonexistent pipeline', async () => {
  const result = await loadPipeline('nonexistent', tmpDir);
  expect(result).toBeNull();
});

test('loadPipeline returns full nested shape for example pipeline', async () => {
  const result = await loadPipeline('example', tmpDir);
  expect(result).not.toBeNull();
  expect(result.name).toBe('example');
  expect(Array.isArray(result.steps)).toBe(true);
  expect(result.steps.length).toBe(1);
  expect(result.steps[0].agent).toBe('researcher');
  expect(result.steps[0].task_template).toBe('Research {{topic}}');
  expect(result.steps[0].goal_template).toBe('deliver findings');
});

test('validatePipeline is a named export', () => {
  expect(typeof validatePipeline).toBe('function');
});

test('validatePipeline({}) throws error mentioning steps', () => {
  expect(() => validatePipeline({})).toThrow(/steps/i);
});

test('validatePipeline({name, steps:[]}) throws error mentioning empty', () => {
  expect(() => validatePipeline({ name: 'x', steps: [] })).toThrow(/empty/i);
});

test('validatePipeline with valid pipeline does not throw', () => {
  expect(() =>
    validatePipeline({
      name: 'x',
      steps: [{ agent: 'a', task_template: 't', goal_template: 'g' }],
    })
  ).not.toThrow();
});
