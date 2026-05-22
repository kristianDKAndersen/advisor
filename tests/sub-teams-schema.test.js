import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const COMPLETE_JS = path.resolve(import.meta.dir, '../sub-teams/lib/complete.js');
const TEAMMATE_MD = path.resolve(import.meta.dir, '../sub-teams/agents/teammate.md');

let tmpDir;

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('complete.js output contains schema_version:1 per teammate.md template', () => {
  // Extract the --output JSON template from teammate.md (the complete.js call line)
  const templateContent = fs.readFileSync(TEAMMATE_MD, 'utf8');
  const match = templateContent.match(/--output '(\{[^']+\})'/);
  expect(match).not.toBeNull();
  const outputTemplate = match[1];

  // Template must declare schema_version:1 — RED before teammate.md edit, GREEN after
  expect(JSON.parse(outputTemplate)).toHaveProperty('schema_version', 1);

  // End-to-end: run complete.js with the template; verify stored task.output.schema_version
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-teams-schema-'));
  const taskId = 't1';
  const taskList = {
    tasks: [{
      id: taskId,
      description: 'test task',
      input: { description: 'test', context: '', goal: 'done' },
      deps: [],
      status: 'in_progress',
      claimed_by: 'teammate-1',
      claimed_at: Math.floor(Date.now() / 1000),
      assigned_teammate: 'teammate-1',
      output: null,
      error: null,
      completed_at: null
    }]
  };
  fs.writeFileSync(path.join(tmpDir, 'task-list.json'), JSON.stringify(taskList, null, 2));

  const result = spawnSync(
    'bun',
    [COMPLETE_JS, '--run-dir', tmpDir, '--task-id', taskId, '--output', outputTemplate],
    { encoding: 'utf8', cwd: tmpDir }
  );

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });

  const updatedList = JSON.parse(fs.readFileSync(path.join(tmpDir, 'task-list.json'), 'utf8'));
  const task = updatedList.tasks.find(t => t.id === taskId);
  expect(task.status).toBe('done');
  expect(task.output.schema_version).toBe(1);
});
